#!/usr/bin/env bash
# End-to-end check of the API behind a REAL Keycloak (the docker-compose.auth.yml overlay).
#
#   docker compose -f docker-compose.yml -f docker-compose.auth.yml up -d --build --wait
#   bash docker/keycloak/smoke.sh
#
# Exits non-zero on the first unexpected status. Safe to run repeatedly (every run uses fresh ids).
set -euo pipefail

API=${API:-http://localhost:3000}
KC=${KC:-http://localhost:8081/realms/wagering/protocol/openid-connect/token}
run=$RANDOM$RANDOM
json='content-type: application/json'

token() { # client id, client secret -> access token (client-credentials grant)
  curl -fsS -d grant_type=client_credentials -d client_id="$1" -d client_secret="$2" "$KC" |
    grep -o '"access_token":"[^"]*"' | cut -d'"' -f4
}
# Corrupts the FIRST character of the signature. (Never the last one: its low bits are base64 padding that decoders
# ignore, so changing it can leave the signature, and the token, valid.)
tamper() {
  local t=$1 sig c n=A
  sig=${t##*.}; c=${sig:0:1}; [ "$c" = A ] && n=B
  echo "${t%.*}.$n${sig:1}"
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
expect() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "  ok   $1 -> $3"; else echo "  FAIL $1 -> got $3, expected $2"; exit 1; fi
}
bet() { # provider id, external id
  echo "{\"providerId\":\"$1\",\"externalTransactionId\":\"$2\",\"kind\":\"BET\",\"playerId\":\"kc-$run\",\"currency\":\"BRL\",\"amount\":\"5.00\",\"roundId\":\"r1\"}"
}

ACME=$(token provider-acme acme-dev-secret)
GLOBEX=$(token provider-globex globex-dev-secret)
OPS=$(token ops-admin ops-dev-secret)
echo "Keycloak issued tokens for acme, globex and ops-admin"

echo "Authentication"
expect "no token" 401 "$(status "$API/wallets/00000000-0000-0000-0000-000000000000")"
expect "tampered token" 401 "$(status "$API/wallets/00000000-0000-0000-0000-000000000000" -H "authorization: Bearer $(tamper "$OPS")")"
expect "probes stay public (live)" 200 "$(status "$API/health/live")"
expect "probes stay public (ready)" 200 "$(status "$API/health/ready")"
expect "metrics stay public" 200 "$(status "$API/metrics")"

echo "Authorization"
wallet=$(curl -fsS -X POST "$API/wallets" -H "$json" -H "authorization: Bearer $OPS" \
  -d "{\"playerId\":\"kc-$run\",\"currency\":\"BRL\",\"openingCredit\":\"100.00\"}")
wid=$(echo "$wallet" | grep -o '"walletId":"[^"]*"' | cut -d'"' -f4)
echo "  ok   ops-admin created a wallet"
expect "acme books a bet as acme" 201 "$(status -X POST "$API/wagering/transactions" -H "$json" -H "authorization: Bearer $ACME" -d "$(bet acme "kc-a-$run")")"
expect "acme tries to book as globex" 403 "$(status -X POST "$API/wagering/transactions" -H "$json" -H "authorization: Bearer $ACME" -d "$(bet globex "kc-b-$run")")"
expect "globex reads acme's transaction" 403 "$(status "$API/providers/acme/wagering/transactions/kc-a-$run" -H "authorization: Bearer $GLOBEX")"
expect "acme reads a wallet (no wallet:read)" 403 "$(status "$API/wallets/$wid" -H "authorization: Bearer $ACME")"
balance=$(curl -fsS "$API/wallets/$wid" -H "authorization: Bearer $OPS" | grep -o '"balance":"[^"]*"' | cut -d'"' -f4)
expect "only the allowed bet was booked" 95.00 "$balance"

echo "All checks passed."
