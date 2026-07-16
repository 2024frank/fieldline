#!/bin/bash
# Onboard a new school onto Fieldline in one command.
# Usage: ./onboard-school.sh "School Name" admin@school.edu ["Admin Name"]
# Prints the login + temporary password to hand to the school.
set -e
ORG="$1"; EMAIL="$2"; NAME="${3:-$2}"
if [ -z "$ORG" ] || [ -z "$EMAIL" ]; then
  echo "usage: $0 \"School Name\" admin@school.edu [\"Admin Name\"]"; exit 1
fi
BASE="http://localhost:4000"
read -p "Your operator email [you@example.com]: " OPEMAIL
OPEMAIL="${OPEMAIL:-you@example.com}"
read -s -p "Your password: " OPPASS; echo
TOK=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$OPEMAIL\",\"password\":\"$OPPASS\"}" | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
[ -z "$TOK" ] && { echo "login failed"; exit 1; }
curl -s -X POST "$BASE/orgs" -H 'Content-Type: application/json' -H "Authorization: Bearer $TOK" \
  -d "{\"orgName\":\"$ORG\",\"adminEmail\":\"$EMAIL\",\"adminName\":\"$NAME\"}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d: print('FAILED:', d['error']); raise SystemExit(1)
print()
print('School onboarded:', d['org']['name'])
print('  Sensor types ready:', d['sensorTypesCloned'])
print()
print('Hand this to the school (they will be forced to change the password):')
print('  App:      https://your-app-domain')
print('  Login:   ', d['admin']['email'])
print('  Password:', d['tempPassword'])
"
