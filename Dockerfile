FROM node:24.22.1-alpine AS builder

ARG GIT_COMMIT=unknown
# Set by Railway on a deploy from GitHub. Used when GIT_COMMIT is not given: the build id keys what
# the app stores for the next visit, so two builds must not share one.
ARG RAILWAY_GIT_COMMIT_SHA
ARG VITE_ARK_SERVER=__VITE_ARK_SERVER__
ARG VITE_SENTRY_DSN=__VITE_SENTRY_DSN__
ARG VITE_NOSTR_RELAY_URL=__VITE_NOSTR_RELAY_URL__
ARG VITE_LNURL_SERVER=__VITE_LNURL_SERVER__
ARG VITE_LNURL_DOMAIN=__VITE_LNURL_DOMAIN__
ARG VITE_CHATWOOT_WEBSITE_TOKEN=__VITE_CHATWOOT_WEBSITE_TOKEN__
ARG VITE_CHATWOOT_BASE_URL=__VITE_CHATWOOT_BASE_URL__
ARG VITE_VERIFIED_ASSETS_URL=__VITE_VERIFIED_ASSETS_URL__
ARG VITE_APP_VERSION=__VITE_APP_VERSION__

ENV VITE_ARK_SERVER=$VITE_ARK_SERVER \
    VITE_SENTRY_DSN=$VITE_SENTRY_DSN \
    VITE_NOSTR_RELAY_URL=$VITE_NOSTR_RELAY_URL \
    VITE_LNURL_SERVER=$VITE_LNURL_SERVER \
    VITE_LNURL_DOMAIN=$VITE_LNURL_DOMAIN \
    VITE_CHATWOOT_WEBSITE_TOKEN=$VITE_CHATWOOT_WEBSITE_TOKEN \
    VITE_CHATWOOT_BASE_URL=$VITE_CHATWOOT_BASE_URL \
    VITE_VERIFIED_ASSETS_URL=$VITE_VERIFIED_ASSETS_URL \
    VITE_APP_VERSION=$VITE_APP_VERSION

RUN corepack enable && corepack prepare pnpm@10.25.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# pnpm-workspace.yaml patches @arkade-os/sdk, and the install fails without the patch file.
COPY patches ./patches
RUN pnpm install --frozen-lockfile

COPY . .
RUN COMMIT="${GIT_COMMIT}"; [ "$COMMIT" != unknown ] || COMMIT="${RAILWAY_GIT_COMMIT_SHA:-unknown}"; \
    echo "export const gitCommit = '$(printf '%s' "$COMMIT" | cut -c1-8)'" > src/_gitCommit.ts && \
    pnpm build:worker && npx vite build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY nginx-security-headers.conf /etc/nginx/security-headers.conf
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY --from=builder /app/dist /usr/share/nginx/html

# Run as non-root user
# conf.d is the entrypoint's too: it sets the port and the optional password gate at start.
RUN mkdir -p /etc/nginx/auth && \
    chown -R nginx:nginx /usr/share/nginx/html /etc/nginx/conf.d /etc/nginx/auth && \
    chown -R nginx:nginx /var/cache/nginx && \
    touch /var/run/nginx.pid && \
    chown nginx:nginx /var/run/nginx.pid

USER nginx
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
