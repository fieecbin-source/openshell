//! SSE 增量解析状态机。
//!
//! 关键约束：网络 chunk 与 SSE 事件边界**没有任何关系**。
//! 因此这里使用带 carry-over 的字节缓冲：
//! - 一个事件可以被拆到任意多个 chunk（甚至拆在 `\r\n` 中间）；
//! - 一个 chunk 内可以粘着多个事件；
//! - 支持 `\n` / `\r\n` / `\r` 三种换行（SSE 规范允许）；
//! - 多行 `data:` 按规范用 `\n` 连接；
//! - 忽略注释行（`:` 开头）与未知字段，畸形行不会中断解析。
//!
//! 缓冲以字节保存，只在完整行通过 UTF-8 解码，避免多字节字符被 chunk 边界切断。

/// 单条已解析完成的 SSE 事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    /// `event:` 字段（如 Anthropic 的 `content_block_delta`）。
    pub event: Option<String>,
    /// 多行 `data:` 用 `\n` 连接后的负载（不含结尾换行）。
    pub data: String,
    /// `id:` 字段。
    pub id: Option<String>,
}

impl SseEvent {
    /// 是否为 OpenAI 兼容流结束标记 `data: [DONE]`。
    pub fn is_done(&self) -> bool {
        self.data.trim() == "[DONE]"
    }
}

/// 增量 SSE 解码器：把任意切分的字节流还原为完整事件。
#[derive(Debug, Default)]
pub struct SseDecoder {
    buffer: Vec<u8>,
    data: String,
    event: Option<String>,
    id: Option<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// 追加一个网络 chunk，返回本次可完整解析出的事件。
    ///
    /// 未完成的行（含末尾孤立的 `\r`）会留在缓冲中等待下一个 chunk。
    pub fn push(&mut self, chunk: impl AsRef<[u8]>) -> Vec<SseEvent> {
        self.buffer.extend_from_slice(chunk.as_ref());
        let mut events = Vec::new();
        self.drain_lines(&mut events);
        events
    }

    /// 流结束：把缓冲中残留的未换行内容当作最后一行处理，并派发未提交事件。
    pub fn finish(&mut self) -> Vec<SseEvent> {
        let mut events = Vec::new();
        self.drain_lines(&mut events);

        if !self.buffer.is_empty() {
            let mut line = std::mem::take(&mut self.buffer);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if let Some(event) = self.process_line(&line) {
                events.push(event);
            }
        }
        if let Some(event) = self.dispatch() {
            events.push(event);
        }
        events
    }

    fn drain_lines(&mut self, events: &mut Vec<SseEvent>) {
        while let Some((end, term_len)) = next_line(&self.buffer) {
            let line: Vec<u8> = self.buffer[..end].to_vec();
            self.buffer.drain(..end + term_len);
            if let Some(event) = self.process_line(&line) {
                events.push(event);
            }
        }
    }

    fn process_line(&mut self, line: &[u8]) -> Option<SseEvent> {
        let text = std::str::from_utf8(line).ok()?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);

        // 空行 = 事件结束。
        if text.is_empty() {
            return self.dispatch();
        }
        // 注释行（常见心跳 `: ping`）。
        if text.starts_with(':') {
            return None;
        }

        let (field, value) = match text.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (text, ""),
        };

        match field {
            "data" => {
                self.data.push_str(value);
                self.data.push('\n');
            }
            "event" => self.event = Some(value.to_string()),
            "id" => self.id = Some(value.to_string()),
            // `retry` / 未知字段忽略。
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEvent> {
        let event = self.event.take();
        let id = self.id.take();
        if self.data.is_empty() {
            return None;
        }
        let mut data = std::mem::take(&mut self.data);
        if data.ends_with('\n') {
            data.pop();
        }
        Some(SseEvent { event, data, id })
    }
}

/// 找到下一条完整行的结束位置与换行长度。
///
/// 末尾孤立的 `\r` 无法判定是 `\r` 还是 `\r\n` 的前半段，必须等待后续字节。
fn next_line(buffer: &[u8]) -> Option<(usize, usize)> {
    for (index, byte) in buffer.iter().enumerate() {
        match byte {
            b'\n' => return Some((index, 1)),
            b'\r' => {
                if index + 1 < buffer.len() {
                    let term_len = if buffer[index + 1] == b'\n' { 2 } else { 1 };
                    return Some((index, term_len));
                }
                return None;
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_of(events: &[SseEvent]) -> Vec<&str> {
        events.iter().map(|event| event.data.as_str()).collect()
    }

    #[test]
    fn parses_event_split_across_chunks() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("da").is_empty());
        assert!(decoder.push("ta: {\"a\":").is_empty());
        let events = decoder.push("1}\n\n");
        assert_eq!(data_of(&events), vec!["{\"a\":1}"]);
    }

    #[test]
    fn parses_multiple_events_in_one_chunk() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push("data: one\n\ndata: two\n\ndata: three\n\n");
        assert_eq!(data_of(&events), vec!["one", "two", "three"]);
    }

    #[test]
    fn handles_crlf_and_split_crlf() {
        let mut decoder = SseDecoder::new();
        // 末尾孤立的 `\r` 不能判定是 `\r` 还是 `\r\n`，必须等待下一个 chunk。
        assert!(decoder.push("data: first\r\n\r").is_empty());

        // `\n` 落在下一个 chunk 上，此时才凑成空行并派发。
        let events = decoder.push("\n");
        assert_eq!(data_of(&events), vec!["first"]);

        let events = decoder.push("data: second\r\n\r\n");
        assert_eq!(data_of(&events), vec!["second"]);

        // 纯 `\r` 换行；末尾孤立 `\r` 在 finish 时补齐。
        assert!(decoder.push("data: third\r\r").is_empty());
        let events = decoder.finish();
        assert_eq!(data_of(&events), vec!["third"]);
    }

    #[test]
    fn joins_multiline_data_with_newline() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push("event: delta\ndata: line1\ndata: line2\n\n");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event.as_deref(), Some("delta"));
        assert_eq!(events[0].data, "line1\nline2");
    }

    #[test]
    fn exposes_done_marker() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push("data: [DONE]\n\n");
        assert_eq!(events.len(), 1);
        assert!(events[0].is_done());
    }

    #[test]
    fn tolerates_comments_unknown_fields_and_bad_utf8() {
        let mut decoder = SseDecoder::new();
        let mut chunk = Vec::new();
        chunk.extend_from_slice(b": keep-alive\n");
        chunk.extend_from_slice(b"retry: 3000\n");
        chunk.extend_from_slice(&[0xff, 0xfe, b'\n']);
        chunk.extend_from_slice(b"data: ok\n\n");
        let events = decoder.push(chunk);
        assert_eq!(data_of(&events), vec!["ok"]);
    }

    #[test]
    fn finish_flushes_unterminated_event() {
        let mut decoder = SseDecoder::new();
        assert!(decoder.push("data: tail").is_empty());
        let events = decoder.finish();
        assert_eq!(data_of(&events), vec!["tail"]);
    }

    #[test]
    fn preserves_utf8_split_in_the_middle_of_a_line() {
        let text = "data: 你好\n\n";
        let bytes = text.as_bytes();
        let mut decoder = SseDecoder::new();
        // 把「你」的三个字节拆到两个 chunk。
        assert!(decoder.push(&bytes[..8]).is_empty());
        let events = decoder.push(&bytes[8..]);
        assert_eq!(data_of(&events), vec!["你好"]);
    }

    #[test]
    fn blank_line_without_data_is_ignored() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push("\n\ndata: x\n\n");
        assert_eq!(data_of(&events), vec!["x"]);
    }

    #[test]
    fn id_field_is_carried_on_the_event() {
        let mut decoder = SseDecoder::new();
        let events = decoder.push("id: 42\ndata: hello\n\n");
        assert_eq!(events[0].id.as_deref(), Some("42"));
    }
}
