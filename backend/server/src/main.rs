use clap::Parser;
use openshell_server::{create_router, AppState, Config, DbPool};
use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "openshell_server=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::parse();

    info!("Opening database from: {}", config.database_url);
    let db = DbPool::open(&config.database_url)?;

    let app_state = AppState::new(db, config.clone());
    let router = create_router(app_state);

    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    info!("OpenShell Server listening on http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, router).await?;

    Ok(())
}
