mock_provider "scaleway" {
  mock_resource "scaleway_container" {
    defaults = {
      id = "nl-ams/33333333-3333-3333-3333-333333333333"
    }
  }

  mock_resource "scaleway_iam_application" {
    defaults = {
      id = "11111111-1111-1111-1111-111111111111"
    }
  }
}

mock_provider "time" {
  mock_resource "time_rotating" {
    defaults = {
      rfc3339          = "2026-01-01T00:00:00Z"
      rotation_rfc3339 = "2026-10-28T00:00:00Z"
    }
  }
}

variables {
  github_api_token                      = "github_pat_test"
  github_webhook_secret                 = "test-secret"
  object_storage_provisioning_principal = "user_id:22222222-2222-2222-2222-222222222222"
  ai_provider_openai_api_key            = "test-key"
  project_id                            = "00000000-0000-0000-0000-000000000000"
  slack_webhook_url                     = "https://example.invalid/webhook"
}

run "deploy_identity_can_publish_images_and_roll_out_containers" {
  command = plan

  assert {
    condition = length(scaleway_iam_policy.runtime_deploy.rule) == 1
    error_message = "The deploy identity must carry exactly one rule, so its scope is readable at a glance."
  }

  assert {
    condition = tolist(scaleway_iam_policy.runtime_deploy.rule[0].permission_set_names) == tolist([
      "ContainerRegistryFullAccess",
      "ContainersFullAccess",
    ])
    error_message = "The deploy identity must hold exactly the registry and container permissions a rollout needs."
  }

  assert {
    condition     = tolist(scaleway_iam_policy.runtime_deploy.rule[0].project_ids) == tolist([var.project_id])
    error_message = "The deploy identity must be confined to the meme project."
  }
}

# The point of splitting this identity out is that a stolen deploy key cannot
# reach anything but the registry and the containers. Without this assertion
# someone could widen the policy back to a general-purpose key and every other
# test here would still pass.
run "deploy_identity_cannot_escalate_beyond_a_rollout" {
  command = plan

  assert {
    condition = length([
      for name in scaleway_iam_policy.runtime_deploy.rule[0].permission_set_names :
      name
      if can(regex("^(IAM|ObjectStorage|MessagingAndQueuing|AllProduct|Organization|Billing|ProjectManager|Secret)", name))
    ]) == 0
    error_message = "The deploy identity must never hold IAM, Object Storage, queue, secret, or organization-wide permissions."
  }

  assert {
    condition = length([
      for name in scaleway_iam_policy.runtime_deploy.rule[0].permission_set_names :
      name
      if endswith(name, "FullAccess") && !contains(["ContainerRegistryFullAccess", "ContainersFullAccess"], name)
    ]) == 0
    error_message = "The deploy identity must not gain any further full-access permission set."
  }
}
