//! 视图卡（Session Card）编排服务。
//!
//! 维护视图卡生命周期、权威状态机（Connecting -> Connected -> Disconnected -> Closed）与模式切换。

use crate::event_bus::EventBus;
use openshell_core_domain::{
    AppEvent, CardId, CardMode, CardState, ConnectionId, DomainError, DomainResult, Protocol,
    SessionCard, SessionId, SessionRepository,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

pub struct CardService {
    cards: Arc<Mutex<HashMap<CardId, SessionCard>>>,
    session_repo: Arc<dyn SessionRepository>,
    event_bus: Arc<EventBus>,
}

impl CardService {
    pub fn new(session_repo: Arc<dyn SessionRepository>, event_bus: Arc<EventBus>) -> Self {
        Self {
            cards: Arc::new(Mutex::new(HashMap::new())),
            session_repo,
            event_bus,
        }
    }

    /// 根据会话 ID 创建新视图卡（初始状态 Connecting）
    pub async fn create_card(&self, session_id: &SessionId) -> DomainResult<SessionCard> {
        let session = self.session_repo.get(session_id).await?;
        let card_id = CardId::new();
        let now = chrono_now_ms();

        let card = SessionCard {
            card_id: card_id.clone(),
            session_id: session.id.clone(),
            name: session.name.clone(),
            protocol: session.protocol,
            current_mode: CardMode::Command,
            state: CardState::Connecting,
            connection_id: None,
            created_at: now,
            last_active_at: now,
        };

        {
            let mut cards = self.cards.lock();
            cards.insert(card_id.clone(), card.clone());
        }

        self.event_bus.emit(AppEvent::CardStateChanged {
            card_id,
            state: CardState::Connecting,
            mode: CardMode::Command,
            reason: None,
        });

        Ok(card)
    }

    /// 绑定底层连接 ID 并将状态提升为 Connected
    pub fn mark_connected(
        &self,
        card_id: &CardId,
        conn_id: Option<ConnectionId>,
    ) -> DomainResult<SessionCard> {
        let mut cards = self.cards.lock();
        let card = cards.get_mut(card_id).ok_or_else(|| {
            DomainError::not_found(format!("card {} not found", card_id.as_str()))
        })?;

        card.state = CardState::Connected;
        card.connection_id = conn_id;
        card.last_active_at = chrono_now_ms();
        let updated = card.clone();

        self.event_bus.emit(AppEvent::CardStateChanged {
            card_id: card_id.clone(),
            state: CardState::Connected,
            mode: card.current_mode,
            reason: None,
        });

        Ok(updated)
    }

    /// 标记断开连接
    pub fn mark_disconnected(
        &self,
        card_id: &CardId,
        reason: Option<String>,
    ) -> DomainResult<SessionCard> {
        let mut cards = self.cards.lock();
        let card = cards.get_mut(card_id).ok_or_else(|| {
            DomainError::not_found(format!("card {} not found", card_id.as_str()))
        })?;

        card.state = CardState::Disconnected;
        card.last_active_at = chrono_now_ms();
        let updated = card.clone();

        self.event_bus.emit(AppEvent::CardStateChanged {
            card_id: card_id.clone(),
            state: CardState::Disconnected,
            mode: card.current_mode,
            reason,
        });

        Ok(updated)
    }

    /// 标记重新连接中
    pub fn mark_reconnecting(&self, card_id: &CardId) -> DomainResult<SessionCard> {
        let mut cards = self.cards.lock();
        let card = cards.get_mut(card_id).ok_or_else(|| {
            DomainError::not_found(format!("card {} not found", card_id.as_str()))
        })?;

        card.state = CardState::Reconnecting;
        card.last_active_at = chrono_now_ms();
        let updated = card.clone();

        self.event_bus.emit(AppEvent::CardStateChanged {
            card_id: card_id.clone(),
            state: CardState::Reconnecting,
            mode: card.current_mode,
            reason: None,
        });

        Ok(updated)
    }

    /// 切换卡片模式（命令模式 / 视图模式）
    pub fn set_mode(&self, card_id: &CardId, mode: CardMode) -> DomainResult<SessionCard> {
        let mut cards = self.cards.lock();
        let card = cards.get_mut(card_id).ok_or_else(|| {
            DomainError::not_found(format!("card {} not found", card_id.as_str()))
        })?;

        // 串口连接严禁切换到视图模式（spec/session-card.md）
        if card.protocol == Protocol::Serial && mode == CardMode::View {
            return Err(DomainError::validation(
                "串口连接仅支持命令模式，不可切换至 SFTP 视图",
            ));
        }

        card.current_mode = mode;
        card.last_active_at = chrono_now_ms();
        let updated = card.clone();

        self.event_bus.emit(AppEvent::CardStateChanged {
            card_id: card_id.clone(),
            state: card.state,
            mode,
            reason: None,
        });

        Ok(updated)
    }

    /// 获取单张卡片
    pub fn get_card(&self, card_id: &CardId) -> DomainResult<SessionCard> {
        let cards = self.cards.lock();
        cards
            .get(card_id)
            .cloned()
            .ok_or_else(|| DomainError::not_found(format!("card {} not found", card_id.as_str())))
    }

    /// 列出所有活动卡片
    pub fn list_cards(&self) -> Vec<SessionCard> {
        let cards = self.cards.lock();
        cards.values().cloned().collect()
    }

    /// 关闭并移除卡片
    pub fn close_card(&self, card_id: &CardId) -> DomainResult<Option<ConnectionId>> {
        let mut cards = self.cards.lock();
        if let Some(card) = cards.remove(card_id) {
            self.event_bus.emit(AppEvent::CardStateChanged {
                card_id: card_id.clone(),
                state: CardState::Closed,
                mode: card.current_mode,
                reason: None,
            });
            Ok(card.connection_id)
        } else {
            Ok(None)
        }
    }
}

fn chrono_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
