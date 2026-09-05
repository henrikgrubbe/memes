output "registry_endpoint" {
  description = "Registry endpoint used by the two-phase image push."
  value       = scaleway_registry_namespace.main.endpoint
}

output "ingress_image" {
  description = "Bootstrap ingress image reference; CI owns later revisions."
  value       = local.ingress_image
}

output "worker_image" {
  description = "Bootstrap worker image reference; CI owns later revisions."
  value       = local.worker_image
}

output "request_queue_url" {
  description = "FIFO request queue URL."
  value       = scaleway_mnq_sqs_queue.requests.url
}

output "dead_letter_queue_url" {
  description = "FIFO dead-letter queue URL."
  value       = scaleway_mnq_sqs_queue.dead_letter.url
}

output "sqs_endpoint" {
  description = "Regional Scaleway SQS endpoint."
  value       = scaleway_mnq_sqs.main.endpoint
}

output "operations_sqs_access_key" {
  description = "Least-privilege SQS access key for DLQ inspection and replay."
  value       = scaleway_mnq_sqs_credentials.operations.access_key
  sensitive   = true
}

output "operations_sqs_secret_key" {
  description = "Least-privilege SQS secret key for DLQ inspection and replay."
  value       = scaleway_mnq_sqs_credentials.operations.secret_key
  sensitive   = true
}

output "ingress_endpoint" {
  description = "Public ingress endpoint, after phase two."
  value       = var.deploy_containers ? scaleway_container.ingress[0].public_endpoint : null
}

output "worker_endpoint" {
  description = "Worker endpoint for health and trigger diagnostics."
  value       = var.deploy_containers ? scaleway_container.worker[0].public_endpoint : null
}

output "ingress_container_id" {
  description = "Ingress container ID used by application deployment automation."
  value       = var.deploy_containers ? split("/", scaleway_container.ingress[0].id)[1] : null
}

output "worker_container_id" {
  description = "Worker container ID used by application deployment automation."
  value       = var.deploy_containers ? split("/", scaleway_container.worker[0].id)[1] : null
}

output "worker_trigger_id" {
  description = "Queue trigger ID when explicitly enabled."
  value       = var.worker_trigger_enabled ? scaleway_container_trigger.worker[0].id : null
}

output "safe_cutover_state" {
  description = "Current routing state visible after every apply."
  value = {
    actions_backend_managed_by_opentofu = false
    ingress_mode                        = var.hosted_ingress_mode
    worker_mode                         = var.worker_mode
    worker_trigger_enabled              = var.worker_trigger_enabled
  }
}
