terraform {
  # State lives in Scaleway Object Storage rather than on one laptop so that CI
  # can detect drift and apply reviewed changes. Backend blocks cannot use
  # variables or locals, so the bucket is spelled out literally on purpose: a
  # partial configuration would silently fall back to local state whenever
  # someone forgot the `-backend-config` flag, which is the exact failure this
  # backend exists to prevent. The project ID is already public in every meme
  # image URL, so naming it here discloses nothing new.
  backend "s3" {
    bucket = "memes-1b1f5129-0bc5-4474-b7a8-15a07a4c645e-tfstate"
    key    = "scaleway/memes.tfstate"
    region = "nl-ams"

    endpoints = {
      s3 = "https://s3.nl-ams.scw.cloud"
    }

    # Scaleway is S3-compatible but is not AWS, so the AWS-only preflight calls
    # have to be skipped or init fails before it reaches the bucket.
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true

    # Address the bucket as <endpoint>/<bucket> instead of <bucket>.<endpoint>.
    # Per-bucket subdomains are prone to being blocked by DNS filters that leave
    # the endpoint hostname reachable, which would make `tofu init` fail on some
    # networks even though the bucket is healthy.
    use_path_style = true

    # Native S3 locking through If-None-Match conditional writes, so two
    # concurrent applies cannot corrupt state. Requires OpenTofu >= 1.10, which
    # versions.tf enforces; Scaleway has no DynamoDB equivalent to fall back on.
    use_lockfile = true
  }
}
