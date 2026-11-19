#!/bin/sh
set -e

# Runtime env var substitution for Vite build output.
# At build time, placeholders like __VITE_ARK_SERVER__ are baked into the JS
# bundle (one ARG per var in the Dockerfile). At container startup each
# placeholder is replaced with the matching VITE_* env var, so one image can
# serve multiple environments. Iterating over the environment means a new
# VITE_* var only needs its ARG in the Dockerfile — no matching line here.

JS_DIR="/usr/share/nginx/html/assets"

for name in $(printenv | sed -n 's/^\(VITE_[A-Za-z0-9_]*\)=.*/\1/p'); do
  value=$(printenv "$name")
  # Skip empties so an unset var leaves its __VITE_*__ placeholder in place;
  # the app treats a leftover placeholder as "unset" (see fromRuntimeEnv).
  [ -n "$value" ] || continue
  escaped_value=$(printf '%s' "$value" | sed 's/[&|\\]/\\&/g')
  find "$JS_DIR" -name '*.js' -exec sed -i "s|__${name}__|${escaped_value}|g" {} +
done

# Hosts such as Railway route to the port they put in PORT. Without it, 80 as before.
if [ -n "${PORT:-}" ]; then
  sed -i "s/listen 80;/listen ${PORT};/" /etc/nginx/conf.d/default.conf
fi

# Optional password gate, the container's equivalent of functions/_middleware.ts on Cloudflare
# Pages: set BASIC_AUTH_USERNAME and BASIC_AUTH_PASSWORD to require them on every request.
# The password is kept in nginx's {PLAIN} form, in a file only this container reads.
rm -f /etc/nginx/auth/gate.conf /etc/nginx/auth/htpasswd
if [ -n "${BASIC_AUTH_USERNAME:-}" ] && [ -n "${BASIC_AUTH_PASSWORD:-}" ]; then
  printf '%s:{PLAIN}%s\n' "$BASIC_AUTH_USERNAME" "$BASIC_AUTH_PASSWORD" > /etc/nginx/auth/htpasswd
  chmod 600 /etc/nginx/auth/htpasswd
  printf 'auth_basic "Restricted";\nauth_basic_user_file /etc/nginx/auth/htpasswd;\n' > /etc/nginx/auth/gate.conf
fi

# A test deployment should not report page views as arkade.money's.
if [ "${DISABLE_ANALYTICS:-}" = "true" ]; then
  sed -i '/plausible\.io\/js\/script\.js/d' /usr/share/nginx/html/index.html
fi

exec "$@"
