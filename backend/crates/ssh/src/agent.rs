use crate::handler::OpenShellClientHandler;
use openshell_core_domain::{DomainError, DomainResult, ErrorCode};
use russh::keys::agent::{client::AgentClient, AgentIdentity};

pub(crate) async fn authenticate(
    handle: &mut russh::client::Handle<OpenShellClientHandler>,
    username: &str,
) -> DomainResult<()> {
    #[cfg(unix)]
    let agent = AgentClient::connect_env().await;
    #[cfg(windows)]
    let agent = AgentClient::connect_named_pipe(
        std::env::var_os("SSH_AUTH_SOCK").unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into()),
    )
    .await;
    #[cfg(any(unix, windows))]
    {
        let mut agent = agent.map_err(|_| auth_error("本地 SSH Agent 不可用"))?;
        authenticate_with(handle, username, &mut agent).await
    }
    #[cfg(not(any(unix, windows)))]
    Err(DomainError::new(
        ErrorCode::AuthMethodUnsupported,
        "当前平台不支持本地 SSH Agent",
    ))
}

fn auth_error(message: &str) -> DomainError {
    DomainError::new(ErrorCode::AuthFailed, message)
}

async fn authenticate_with<S>(
    handle: &mut russh::client::Handle<OpenShellClientHandler>,
    username: &str,
    agent: &mut AgentClient<S>,
) -> DomainResult<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|_| auth_error("无法读取 SSH Agent 身份"))?;
    if identities.is_empty() {
        return Err(auth_error("SSH Agent 没有可用身份"));
    }
    for identity in identities {
        let public_key = identity.public_key();
        let hash_alg = if public_key.algorithm().is_rsa() {
            handle
                .best_supported_rsa_hash()
                .await
                .map_err(|_| auth_error("无法协商 SSH Agent 签名算法"))?
                .flatten()
        } else {
            None
        };
        let result = match identity {
            AgentIdentity::PublicKey { key, .. } => {
                handle
                    .authenticate_publickey_with(username, key, hash_alg, agent)
                    .await
            }
            AgentIdentity::Certificate { certificate, .. } => {
                handle
                    .authenticate_certificate_with(username, certificate, hash_alg, agent)
                    .await
            }
        }
        .map_err(|_| auth_error("SSH Agent 签名失败或拒绝签名"))?;
        if result.success() {
            return Ok(());
        }
    }
    Err(auth_error("服务器拒绝 SSH Agent 身份"))
}

#[cfg(all(test, windows))]
mod tests {
    use crate::{ConnectOptions, SshConnection};
    use openshell_core_domain::{AuthMethod, ConnectionId, HostKeyPolicy, SessionId};
    use russh::keys::signature::Signer;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn key(seed: u8) -> russh::keys::PrivateKey {
        russh::keys::PrivateKey::new(
            russh::keys::ssh_key::private::KeypairData::Ed25519(
                russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[seed; 32]),
            ),
            "one-time signing fixture",
        )
        .unwrap()
    }

    fn string(output: &mut Vec<u8>, value: &[u8]) {
        output.extend_from_slice(&(value.len() as u32).to_be_bytes());
        output.extend_from_slice(value);
    }

    fn read_string<'a>(input: &mut &'a [u8]) -> &'a [u8] {
        let len = u32::from_be_bytes(input[..4].try_into().unwrap()) as usize;
        let value = &input[4..4 + len];
        *input = &input[4 + len..];
        value
    }

    struct Server {
        allowed: russh::keys::PublicKey,
        verified: Arc<AtomicUsize>,
        accept: bool,
    }
    impl russh::server::Handler for Server {
        type Error = russh::Error;
        async fn auth_publickey(
            &mut self,
            _: &str,
            key: &russh::keys::PublicKey,
        ) -> Result<russh::server::Auth, Self::Error> {
            // SSH wire keys omit comments; match cryptographic key material after signature verification.
            if key.key_data() == self.allowed.key_data() {
                self.verified.fetch_add(1, Ordering::SeqCst);
                if self.accept {
                    return Ok(russh::server::Auth::Accept);
                }
            }
            Ok(russh::server::Auth::reject())
        }
    }

    #[tokio::test]
    async fn one_time_agent_signs_real_authentication_and_rejects_failures() {
        struct RestoreEnv(Option<std::ffi::OsString>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("SSH_AUTH_SOCK", value),
                    None => std::env::remove_var("SSH_AUTH_SOCK"),
                }
            }
        }
        let _restore = RestoreEnv(std::env::var_os("SSH_AUTH_SOCK"));
        tokio::time::timeout(Duration::from_secs(15), async {
            for (empty, refuse, accept, missing) in [
                (false, false, true, false),
                (true, false, true, false),
                (false, true, true, false),
                (false, false, false, false),
                (false, false, true, true),
            ] {
                let user_key = key(51);
                let verified = Arc::new(AtomicUsize::new(0));
                let server_handler = Server {
                    allowed: user_key.public_key().clone(),
                    verified: verified.clone(),
                    accept,
                };
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let config = Arc::new(russh::server::Config {
                    keys: vec![key(52)],
                    auth_rejection_time: Duration::ZERO,
                    ..Default::default()
                });
                let server = tokio::spawn(async move {
                    let (socket, _) = listener.accept().await.unwrap();
                    if let Ok(session) =
                        russh::server::run_stream(config, socket, server_handler).await
                    {
                        let _ = session.await;
                    }
                });
                let pipe = format!(
                    r"\\.\pipe\openshell-agent-test-{}-{}",
                    std::process::id(),
                    addr.port()
                );
                let agent_socket = if missing {
                    None
                } else {
                    Some(
                        tokio::net::windows::named_pipe::ServerOptions::new()
                            .first_pipe_instance(true)
                            .create(&pipe)
                            .unwrap(),
                    )
                };
                std::env::set_var("SSH_AUTH_SOCK", &pipe);
                let signing_agent = tokio::spawn(async move {
                    let Some(mut agent_socket) = agent_socket else {
                        return;
                    };
                    agent_socket.connect().await.unwrap();
                    while let Ok(len) = agent_socket.read_u32().await {
                        assert!(len < 65536);
                        let mut frame = vec![0; len as usize];
                        agent_socket.read_exact(&mut frame).await.unwrap();
                        let mut response = Vec::new();
                        match frame[0] {
                            11 => {
                                response.push(12);
                                response.extend_from_slice(
                                    &(if empty { 0u32 } else { 1u32 }).to_be_bytes(),
                                );
                                if !empty {
                                    string(
                                        &mut response,
                                        &user_key.public_key().to_bytes().unwrap(),
                                    );
                                    string(&mut response, b"isolated one-time agent");
                                }
                            }
                            13 if !refuse => {
                                let mut data = &frame[1..];
                                assert_eq!(
                                    read_string(&mut data),
                                    user_key.public_key().to_bytes().unwrap()
                                );
                                let signature: russh::keys::ssh_key::Signature =
                                    user_key.try_sign(read_string(&mut data)).unwrap();
                                let mut blob = Vec::new();
                                string(&mut blob, b"ssh-ed25519");
                                string(&mut blob, signature.as_bytes());
                                response.push(14);
                                string(&mut response, &blob);
                            }
                            _ => response.push(5),
                        }
                        agent_socket.write_u32(response.len() as u32).await.unwrap();
                        agent_socket.write_all(&response).await.unwrap();
                    }
                });
                let result = SshConnection::connect(
                    ConnectOptions {
                        connection_id: ConnectionId::new(),
                        session_id: SessionId::new(),
                        host: addr.ip().to_string(),
                        port: addr.port(),
                        username: "fixture-user".into(),
                        auth_method: AuthMethod::Agent,
                        password: None,
                        private_key_pem: None,
                        private_key_passphrase: None,
                        host_key_policy: HostKeyPolicy::Insecure,
                        keepalive_sec: 0,
                        keepalive_max_miss: 3,
                        timeout_sec: 5,
                        compression: false,
                        agent_forwarding: false,
                        x11_forwarding: None,
                    },
                    None,
                )
                .await;
                assert_eq!(
                    result.is_ok(),
                    !empty && !refuse && accept && !missing,
                    "Agent scenario empty={empty}, refuse={refuse}, accept={accept}, missing={missing}: {:?}",
                    result.as_ref().err()
                );
                assert_eq!(
                    verified.load(Ordering::SeqCst),
                    usize::from(!empty && !refuse && !missing)
                );
                signing_agent.await.unwrap();
                if let Ok(connection) = result {
                    connection.close().await.unwrap();
                }
                server.abort();
            }
        })
        .await
        .expect("isolated Agent authentication timed out");
    }
}
