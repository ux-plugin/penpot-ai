use crate::dependencies::AppDependencies;
use tauri::State;

#[tauri::command]
pub async fn start_server(deps: State<'_, AppDependencies>) -> Result<u16, String> {
    deps.local_server().get_or_start().await
}

#[tauri::command]
pub async fn stop_server(deps: State<'_, AppDependencies>) -> Result<(), String> {
    deps.local_server().stop().await
}
