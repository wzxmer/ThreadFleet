use super::*;

const EXECUTE_METHOD: &str = "execute_windows_installer_migration";
const PREPARE_METHOD: &str = "prepare_windows_installer_migration";

pub(super) async fn try_handle(
    _state: &DaemonState,
    method: &str,
    _params: &Value,
) -> Option<Result<Value, String>> {
    remote_execution_rejection(method)
}

fn remote_execution_rejection(method: &str) -> Option<Result<Value, String>> {
    if !matches!(method, EXECUTE_METHOD | PREPARE_METHOD) {
        return None;
    }
    Some(Err(
        "Windows installer migration is restricted to the local desktop runtime and cannot be invoked over daemon RPC."
            .into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_authority_methods_are_explicitly_rejected_over_rpc() {
        for method in [PREPARE_METHOD, EXECUTE_METHOD] {
            let result =
                remote_execution_rejection(method).expect("method is owned by this adapter");
            assert!(result.unwrap_err().contains("local desktop runtime"));
        }
        assert!(remote_execution_rejection("unrelated").is_none());
    }
}
