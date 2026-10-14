#!/bin/sh
# Generates the keys and certificates for mutual TLS between the telepi server and the OpenShell gateway:
#   tls/ca.crt, ca.key          a private CA (the key never leaves this directory; nothing signs with it later)
#   tls/server.crt, server.key  the gateway's certificate (localhost, 127.0.0.1, ::1, host.openshell.internal)
#   tls/client.crt, client.key  the telepi server's certificate: CN=telepi-server, OU=openshell-user (a user, not an admin)
# tls/cli holds the same client bundle laid out for the openshell CLI. openssl runs in a container, nothing is installed on the host. Existing files are kept; FORCE=1 replaces them all.
set -eu
cd "$(dirname "$0")"
mkdir -p tls
if [ -f tls/ca.crt ] && [ "${FORCE:-}" != 1 ]; then
  echo "tls/ca.crt exists; keeping the current certificates (FORCE=1 replaces them)."
  exit 0
fi
docker run --rm -v "$PWD/tls:/out" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" node:22-bookworm sh -eu -c '
cd /out
rm -f ./*.crt ./*.key ./*.csr ./*.srl ./*.ext
key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }

key ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 -subj "/CN=telepi OpenShell CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" -out ca.crt

key server.key
openssl req -new -key server.key -subj "/CN=openshell-gateway" -out server.csr
printf "%s\n" "basicConstraints=CA:FALSE" "keyUsage=digitalSignature" "extendedKeyUsage=serverAuth" \
  "subjectAltName=DNS:localhost,DNS:openshell-gateway,DNS:host.openshell.internal,IP:127.0.0.1,IP:::1" > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 -extfile server.ext -out server.crt 2>/dev/null

key client.key
openssl req -new -key client.key -subj "/CN=telepi-server/OU=openshell-user" -out client.csr
printf "%s\n" "basicConstraints=CA:FALSE" "keyUsage=digitalSignature" "extendedKeyUsage=clientAuth" > client.ext
openssl x509 -req -in client.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 825 -extfile client.ext -out client.crt 2>/dev/null

rm -f ./*.csr ./*.srl ./*.ext
chmod 644 ./*.crt
chmod 600 ./*.key
chown "$HOST_UID:$HOST_GID" ./*
'

# The openshell CLI container (compose service "cli") reads its gateway registration and client bundle from here.
d=tls/cli/gateways/telepi
mkdir -p "$d/mtls"
cp tls/ca.crt "$d/mtls/ca.crt"; cp tls/client.crt "$d/mtls/tls.crt"; cp tls/client.key "$d/mtls/tls.key"
printf "telepi" > tls/cli/active_gateway
cat > "$d/metadata.json" <<JSON
{ "name": "telepi", "gateway_endpoint": "https://openshell-gateway:8080", "is_remote": true, "gateway_port": 0, "auth_mode": "mtls" }
JSON
echo "Wrote tls/{ca,server,client}.{crt,key} and tls/cli (keys are git-ignored)."
