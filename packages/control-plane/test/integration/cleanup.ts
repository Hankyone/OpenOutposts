import { env } from "cloudflare:test";

/**
 * Clears all D1 tables. Integration tests share a single D1 instance, so call
 * this in beforeEach/afterEach to isolate state between tests.
 */
export async function cleanD1Tables(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM oauth_authorization_codes; DELETE FROM browser_auth_sessions; DELETE FROM provider_credentials; DELETE FROM verified_email_claims; DELETE FROM oauth_flow_state; DELETE FROM automation_slack_channels; DELETE FROM automation_runs; DELETE FROM automation_invocations; DELETE FROM automation_repositories; DELETE FROM automation_environments; DELETE FROM automations; DELETE FROM session_pull_requests; DELETE FROM session_repositories; DELETE FROM sessions; DELETE FROM service_auth_nonces; DELETE FROM outpost_connect_nonces; DELETE FROM outpost_enrollments; DELETE FROM outposts; DELETE FROM user_scm_tokens; DELETE FROM repo_metadata; DELETE FROM repo_secrets; DELETE FROM global_secrets; DELETE FROM commit_signing_configuration; DELETE FROM integration_settings; DELETE FROM integration_repo_settings; DELETE FROM integration_environment_settings; DELETE FROM model_preferences; DELETE FROM mcp_servers; DELETE FROM provider_oauth_flows; DELETE FROM user_provider_credentials; DELETE FROM user_identities; DELETE FROM users; DELETE FROM api_tokens; DELETE FROM environment_secrets; DELETE FROM environment_repositories; DELETE FROM environments; DELETE FROM homestead_model_catalogs;"
  );
}
