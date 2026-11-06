#!/bin/sh
# Runs a relay on a small Google Cloud VM, so two players on different networks can reach one.
#   scripts/deploy-relay-gcloud.sh PROJECT [ZONE]
# It's safe to run again: that sends the current relay code to the VM and restarts it.
# To remove everything it creates, run the commands it prints at the end.
#
# The relay holds nothing secret and has no power over a match, so the VM gets no access to anything else in
# the project: no service account, and only the relay's port opened beyond what the project already allows.
# SSH is off on the VM. To debug it, read its serial output with gcloud compute instances get-serial-port-output.
set -eu
PROJECT="${1:?Usage: scripts/deploy-relay-gcloud.sh PROJECT [ZONE]}"
ZONE="${2:-us-central1-a}"
REGION="${ZONE%-*}"
NAME=stacks-relay
PORT=8787
cd "$(dirname "$0")/.."
gc() { gcloud --quiet --project "$PROJECT" "$@"; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bundle/scripts" "$work/bundle/src/channel"
cp scripts/channel-relay.js "$work/bundle/scripts/"
cp src/channel/relay.js "$work/bundle/src/channel/"
printf '{"type":"module"}\n' > "$work/bundle/package.json"
tar -C "$work/bundle" -czf "$work/bundle.tgz" .
base64 < "$work/bundle.tgz" | tr -d '\n' > "$work/bundle.b64"

cat > "$work/startup.sh" <<'STARTUP'
#!/bin/sh
set -eu
meta=http://metadata.google.internal/computeMetadata/v1/instance/attributes
export DEBIAN_FRONTEND=noninteractive
command -v node >/dev/null || { apt-get update -q; apt-get install -yq nodejs unattended-upgrades; }
rm -rf /opt/stacks-relay.new && mkdir -p /opt/stacks-relay.new
curl -fsS -H 'Metadata-Flavor: Google' "$meta/relay-bundle" | base64 -d | tar -xz -C /opt/stacks-relay.new
chmod -R a+rX /opt/stacks-relay.new
rm -rf /opt/stacks-relay && mv /opt/stacks-relay.new /opt/stacks-relay
cat > /etc/systemd/system/stacks-relay.service <<UNIT
[Unit]
Description=Agent Stacks relay
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/node /opt/stacks-relay/scripts/channel-relay.js 8787 0.0.0.0
WorkingDirectory=/opt/stacks-relay
Restart=always
RestartSec=2
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
CapabilityBoundingSet=
MemoryMax=700M
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable stacks-relay
systemctl restart stacks-relay
# Updates arrive through this script, so nothing needs to log in.
systemctl disable --now ssh ssh.socket 2>/dev/null || true
STARTUP

if ! gc compute addresses describe "$NAME-ip" --region "$REGION" >/dev/null 2>&1; then
  gc compute addresses create "$NAME-ip" --region "$REGION" >/dev/null
fi
ADDRESS="$(gc compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)')"

if ! gc compute firewall-rules describe "$NAME-allow" >/dev/null 2>&1; then
  gc compute firewall-rules create "$NAME-allow" --direction=INGRESS --action=ALLOW --rules="tcp:$PORT" --source-ranges=0.0.0.0/0 --target-tags="$NAME" >/dev/null
fi

if gc compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  gc compute instances add-metadata "$NAME" --zone "$ZONE" --metadata-from-file="relay-bundle=$work/bundle.b64,startup-script=$work/startup.sh" >/dev/null
  gc compute instances reset "$NAME" --zone "$ZONE" >/dev/null
else
  gc compute instances create "$NAME" --zone "$ZONE" --machine-type=e2-micro \
    --image-family=debian-13 --image-project=debian-cloud \
    --boot-disk-size=10GB --boot-disk-type=pd-standard \
    --address="$ADDRESS" --tags="$NAME" \
    --no-service-account --no-scopes \
    --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
    --metadata=enable-oslogin=TRUE,block-project-ssh-keys=TRUE \
    --metadata-from-file="relay-bundle=$work/bundle.b64,startup-script=$work/startup.sh" >/dev/null
fi

printf 'Waiting for the relay at http://%s:%s' "$ADDRESS" "$PORT" >&2
tries=0
until curl -fsS --max-time 3 "http://$ADDRESS:$PORT/health" >/dev/null 2>&1; do
  tries=$((tries+1))
  [ "$tries" -lt 80 ] || { echo ' it did not come up.' >&2; exit 1; }
  printf . >&2
  sleep 5
done
echo ' up.' >&2
cat >&2 <<DONE

To remove it all:
  gcloud --project $PROJECT compute instances delete $NAME --zone $ZONE
  gcloud --project $PROJECT compute firewall-rules delete $NAME-allow
  gcloud --project $PROJECT compute addresses delete $NAME-ip --region $REGION
DONE
echo "http://$ADDRESS:$PORT"
