---
name: sui-validater
description: Operate FP-Validated Sui validator deployments in k3s/ArgoCD. Use for Sui validator cutovers, Vault key parity checks, DNS/hostNetwork validation, static local PV mapping, ExternalSecret sync, probe fixes, and post-deploy consensus health checks in k3s-chain-repo.
enabled: false
---

# Sui Validator k3s Operations

## Scope

Use this skill for Sui validator work in ~/4pillars/k3s-chain-repo:

- cutover from host systemd Sui validator to k3s
- Vault-backed validator config and key-pair checks
- ArgoCD deployment and sync checks
- DNS/hostNetwork exposure matching Walrus-style validator operations
- static local PV mapping to an existing Sui DB
- post-deploy validation from Kubernetes status and Sui metrics

Do not use this skill for FitBody repositories or fitbody-ops workflows.

## Safety Rules

- Always run kubectl config current-context and inspect the API server before cluster operations.
- Never execute commands under ~/fit-body/** for this workflow.
- Treat existing repo changes as user work. Do not reset, stash, or revert unrelated changes.
- Do not print private key contents. Compare keys by hashes only.
- Do not deploy mainnet artifacts when the request is testnet-only.
- Stop host systemd only after key/config parity and storage mapping are verified.
- Use short verification loops. Do not wait indefinitely; inspect and fix the blocking condition.

## Testnet Deployment Contract

The current Sui testnet validator deployment uses:

- namespace: sui-testnet-01
- ArgoCD app: sui-testnet-validator-01
- node: ovh-node-5
- DNS: sui-testnet.4pillars.info -> 162.19.138.239
- image: mysten/sui-node:testnet-v1.73.0
- host networking: enabled
- public LoadBalancer: disabled
- UDP 8084 for Sui P2P/consensus
- TCP 9184 for metrics
- TCP 8080 for node network HTTP address
- TCP 1337 admin, not public RPC
- JSON-RPC 9000 is not required for validator health and may be closed.

## Mainnet Deployment Contract

The current Sui mainnet validator deployment uses:

- namespace: sui-mainnet-01
- ArgoCD app: sui-mainnet-validator-01
- node: ovh-node-4
- DNS: sui-mainnet.4pillars.info -> 141.95.126.9
- image: mysten/sui-node:mainnet-v1.72.5
- deployed/local version verified equal: sui-node 1.72.5-5445323ef25a
- host networking: enabled
- public LoadBalancer: disabled
- UDP 8084 for Sui P2P/consensus
- TCP 9184 for metrics
- TCP 8080 for node network HTTP address
- TCP 1337 admin, not public RPC
- JSON-RPC 9000 is not required for validator health and may be closed.

Mainnet repo artifacts:

- argocd/applications/sui-mainnet/_namespace.yaml
- argocd/applications/sui-mainnet/validator-01.yaml
- variables/sui-mainnet/common-values.yaml
- variables/sui-mainnet/validator-01.yaml
- ops/sui-mainnet-vault-prep.md

Mainnet deployment was verified with:

- ArgoCD application: Synced Healthy Succeeded
- StatefulSet: 1/1
- pod: sui-mainnet-validator-01-0 Running, ready=true, restarts=0, node=ovh-node-4, IP=141.95.126.9
- metrics endpoint: http://141.95.126.9:9184/metrics returns HTTP 200
- ExternalSecrets: sui-mainnet-validator-01-config and sui-mainnet-validator-01-key-pairs SecretSynced True

## Vault Layout

Use separate Vault records and Kubernetes Secrets per network:

Testnet:

- secret/sui/testnet/validator-01/config: validator.yaml
- secret/sui/testnet/validator-01/key-pairs: protocol.key, worker.key, network.key, account.key
- Kubernetes Secrets: sui-testnet-validator-01-config, sui-testnet-validator-01-key-pairs

Mainnet:

- secret/sui/mainnet/validator-01/config: validator.yaml
- secret/sui/mainnet/validator-01/key-pairs: protocol.key, worker.key, network.key, account.key
- Kubernetes Secrets: sui-mainnet-validator-01-config, sui-mainnet-validator-01-key-pairs

Do not store public genesis.blob in Vault. The init container downloads public Sui genesis for the selected network.

## Required Validator Config

Vault validator.yaml must reference mounted k8s paths:

- protocol key: /opt/sui/key-pairs/protocol.key
- worker key: /opt/sui/key-pairs/worker.key
- network key: /opt/sui/key-pairs/network.key
- db path: /opt/sui/db/authorities_db
- consensus db path: /opt/sui/db/consensus_db
- metrics address: 0.0.0.0:9184
- P2P listen address: 0.0.0.0:8084
- P2P external address:
  - testnet: /dns/sui-testnet.4pillars.info/udp/8084
  - mainnet: /dns/sui-mainnet.4pillars.info/udp/8084
- genesis file: /opt/sui/config/genesis.blob
- state archive ingestion URL:
  - testnet: https://checkpoints.testnet.sui.io
  - mainnet: https://checkpoints.mainnet.sui.io

## Pre-Cutover Checklist

1. Confirm Kubernetes context and API server.
2. Confirm network DNS resolves to the intended node public IP:
   - testnet: sui-testnet.4pillars.info -> 162.19.138.239
   - mainnet: sui-mainnet.4pillars.info -> 141.95.126.9
3. Confirm live host paths on the target node:
   - /opt/sui/config/validator.yaml
   - /opt/sui/key-pairs/protocol.key
   - /opt/sui/key-pairs/worker.key
   - /opt/sui/key-pairs/network.key
   - /opt/sui/key-pairs/account.key
   - /opt/sui/db
4. Compare live and Vault keys by SHA-256. If any hash differs, import the live files into Vault before stopping systemd.
5. Ensure storage maps to existing DB path with staticHostPath:
   - type: staticHostPath
   - class: empty string
   - size: 4Ti
   - hostPath: /opt/sui/db
   - nodeName: target node

Rendered PV must use local.path /opt/sui/db, storageClassName empty string, persistentVolumeReclaimPolicy Retain, and node affinity to the target node.

## Cutover Workflow

Before mutation run targeted validation:

- python3 -m pytest tests/test_sui_mainnet_templates.py
- helm lint charts/chain-templates with the target network common-values.yaml and validator-01.yaml
- helm template to /tmp/sui-render.yaml
- kubectl apply --dry-run=client -f /tmp/sui-render.yaml

After parity checks pass:

1. Stop and disable host systemd sui-node on the target node.
2. Confirm ports 8080, 8084, 9000, 9184, and 1337 are not still owned by systemd.
3. Commit and push the ArgoCD Application/values changes to main.
4. Patch the ArgoCD Application operation sync to revision main.
5. Use short checks with kubectl get externalsecret,secret,pv,pvc,pod,svc -n <sui-namespace> -o wide.

## Probe Rule

Do not use JSON-RPC 9000 as the default readiness gate for validators. Sui validator config may not expose RPC.

For testnet validator probes, target metrics:

- sui.probes.enabled: true
- sui.probes.port: metrics
- initialDelaySeconds: 30
- periodSeconds: 30
- timeoutSeconds: 5
- failureThreshold: 60

If the pod is running but unready, check whether probes still target rpc instead of metrics.

## Post-Deploy Validation

Expected Kubernetes state:

- pod 1/1 Running, restarts 0
- StatefulSet 1/1
- ArgoCD Synced Healthy
- both ExternalSecrets SecretSynced True

Metrics endpoints:

- testnet: http://162.19.138.239:9184/metrics returns HTTP 200
- mainnet: http://141.95.126.9:9184/metrics returns HTTP 200
Good sync signals:

- consensus_commit_sync_local_index near consensus_commit_sync_quorum_index
- consensus_commit_sync_pending_fetches 0
- consensus_commit_sync_inflight_fetches 0
- consensus_commit_sync_fetched_index present

## Monitoring / Log-Guard Checks

For Sui mainnet on ovh-node-4, monitoring lives in the separate repo `~/4pillars/monitoring` and ArgoCD app `validated-guard-ovh-node-4`.

Required ovh-node-4 log-guard config:

- `instances/nodes/ovh-node-4.yaml`
- `logGuard.enabled: true`
- `enabledPodsProfiles` includes `sui-mainnet`
- `podsProfiles.sui-mainnet.path: /var/log/pods/sui-mainnet-01_*/*/*.log`
- `podsProfiles.sui-mainnet.tag: k8s.sui.mainnet`

Mainnet log-guard was verified with:

- `validator-monitoring` pod `vg-ovh-node-4-log-guard-*` Running 3/3
- Fluent Bit health endpoint OK on `127.0.0.1:2020`
- Fluent Bit metrics endpoint OK on `127.0.0.1:2020/api/v1/metrics/prometheus`
- `fluentbit_output_errors_total{name="file.0"} 0`
- blackbox tailer logs included Sui pod output after adding the `sui-mainnet` pod profile

Prometheus target for Sui mainnet was verified:

- scrape URL: `http://141.95.126.9:9184/metrics`
- health: `up`
- labels include `chain='sui'`, `network='mainnet'`, `namespace='sui-mainnet-01'`, `service='sui-mainnet-validator-01-ci'`, `pod='sui-mainnet-validator-01-0'`


## RPC Expectations

Do not require JSON-RPC 9000 for validator health. If public JSON-RPC calls are needed, deploy a separate Sui fullnode/RPC service instead of opening public RPC on the validator.

## Benign Warnings Seen During Successful Cutover

These warnings are not readiness failures by themselves:

- jwk_updater_task JWKRetrievalError
- anemo_tower trace connection lost or closed
- occasional h2 recv_reset

Treat them as actionable only with restarts, failed metrics-based probes, no consensus metrics movement, or loss of P2P/metrics ports.
