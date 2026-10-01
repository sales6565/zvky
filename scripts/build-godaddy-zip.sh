#!/usr/bin/env bash
# Builds the upload archive for cPanel / GoDaddy Node.js hosting.
#
#   npm run package
#
# Produces dist/zvky-backend-godaddy.zip containing the application source and
# .env.example, but no node_modules — cPanel installs dependencies itself with
# "Run NPM Install", which also builds anything platform-specific correctly.
#
# It contains no .env and no secret of any kind: set DB_HOST, DB_NAME, DB_USER,
# DB_PASSWORD, JWT_SECRET, CORS_ORIGIN and the rest as the application's
# environment variables on the host (DEPLOY-GODADDY.md).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/dist"
STAGE="$OUT_DIR/zvky-backend"
ZIP="$OUT_DIR/zvky-backend-godaddy.zip"

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

# The bulk-upload sample, generated from the column spec the importer validates
# against rather than kept by hand. The checked-in copy had drifted two rewrites
# behind — it still described the seven-column format, so the one file meant to
# show a studio the right shape was itself rejected by the importer.
node -e "process.stdout.write(require('$ROOT/src/asset-import').buildTemplateCsv())" \
  > "$ROOT/sample-bulk-import.csv"

# Application files only. node_modules, .git, uploads and any local .env stay out.
for item in app.js package.json README.md DEPLOY-GODADDY.md sample-bulk-import.csv src public sql; do
  [ -e "$ROOT/$item" ] && cp -r "$ROOT/$item" "$STAGE/"
done
cp "$ROOT/.env.example" "$STAGE/.env.example"

# uploads/ must exist and be writable; keep it in the archive but empty.
mkdir -p "$STAGE/uploads"
cat > "$STAGE/uploads/.gitkeep" <<'EOF'
EOF

# NO .env IN THE ARCHIVE. Settings and secrets (database password, JWT_SECRET,
# integration secrets) are set as the application's environment variables in
# cPanel's Node.js app screen, never written into a file that is uploaded or
# committed. .env.example travels with it as the list of names.
if find "$STAGE" \( -name '.env' -o -name '.env.*' -o -name '*.env' \) ! -name '.env.example' | grep -q .; then
  echo "Refusing to build: an environment file is in the archive staging folder." >&2
  exit 1
fi

cd "$OUT_DIR"
zip -qr "$(basename "$ZIP")" "zvky-backend"
cd "$ROOT"
rm -rf "$STAGE"

echo "Built $ZIP"
echo "It contains no .env: set the application's environment variables on the host (see .env.example)."
unzip -l "$ZIP" | tail -3
