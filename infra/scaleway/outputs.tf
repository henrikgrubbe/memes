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

output "object_storage_bucket" {
  description = "Bucket receiving newly hosted meme images."
  value       = scaleway_object_bucket.images.name
}

output "object_storage_endpoint" {
  description = "Regional S3-compatible endpoint used by the worker."
  value       = local.object_storage_endpoint
}

output "object_storage_public_base_url" {
  description = "Permanent public base URL for objects under the memes prefix."
  value       = local.object_storage_public_url
}

output "worker_object_storage_access_key" {
  description = "Dedicated worker Object Storage access key."
  value       = scaleway_iam_api_key.worker_storage.access_key
  sensitive   = true
}

output "worker_object_storage_secret_key" {
  description = "Dedicated worker Object Storage secret key."
  value       = scaleway_iam_api_key.worker_storage.secret_key
  sensitive   = true
}

output "worker_object_storage_key_expires_at" {
  description = "Expiration timestamp for the current worker Object Storage API key."
  value       = scaleway_iam_api_key.worker_storage.expires_at
}

output "worker_object_storage_key_rotation_at" {
  description = "Next apply-time rotation deadline for the worker Object Storage API key."
  value       = time_rotating.worker_storage.rotation_rfc3339
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
  description = "Public ingress endpoint."
  value       = scaleway_container.ingress.public_endpoint
}

output "worker_endpoint" {
  description = "Private worker endpoint."
  value       = scaleway_container.worker.public_endpoint
}

output "ingress_container_id" {
  description = "Ingress container ID used by application deployment automation."
  value       = split("/", scaleway_container.ingress.id)[1]
}

output "worker_container_id" {
  description = "Worker container ID used by application deployment automation."
  value       = split("/", scaleway_container.worker.id)[1]
}

output "worker_trigger_id" {
  description = "Queue trigger ID."
  value       = scaleway_container_trigger.worker.id
}
