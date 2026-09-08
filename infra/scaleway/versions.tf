terraform {
  # 1.10 is the floor because backend.tf relies on `use_lockfile`, which does
  # not exist in 1.9. On 1.9 the backend would run with no locking at all
  # rather than failing, so the constraint has to exclude it.
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    scaleway = {
      source  = "scaleway/scaleway"
      version = "~> 2.82.0"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.14.0"
    }
  }
}

provider "scaleway" {
  project_id = var.project_id
  region     = var.region
}
