# Prometheus exporter for shelly plug s gen 3

- single purpose for shelly plug s gen 3
- using auto discovery
- supports multiple devices
- single exporter in docker container
- docker compose example (as I'm using it in my homelab)

## Docker compose example

```yaml
services:
  shelly-exporter:
    image: ghcr.io/simonjur/shelly-plug-s-g3-prometheus-exporter/shelly-plug-s-gen3-exporter:latest
    container_name: shelly-exporter
    restart: unless-stopped
    network_mode: host
```