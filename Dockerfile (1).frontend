# ============================================================
# Axis Underwriting Agent — Web Server (Web EC2)
# Static frontend + auth-gated page routes
# ============================================================

# ---- builder stage: full deps (incl. Tailwind) + compile CSS ----
FROM node:20-alpine AS builder
WORKDIR /usr/src/app

COPY package.json ./
# Install all deps (including devDeps: tailwindcss, postcss, autoprefixer)
RUN npm install

COPY tailwind.config.js ./
COPY src ./src
COPY public ./public

# Compile Tailwind → minified public/styles.css
RUN npm run build:css

# ---- deps stage: production-only deps (no Tailwind/PostCSS) ----
FROM node:20-alpine AS deps
WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# ---- runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /usr/src/app

ENV NODE_ENV=production

# Non-root user
RUN addgroup -S appuser && adduser -S appuser -G appuser

# Copy production node_modules
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy only the files the web server needs at runtime
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY config ./config
COPY public ./public

# Overwrite styles.css with the freshly built Tailwind output
COPY --from=builder /usr/src/app/public/styles.css ./public/styles.css

RUN chown -R appuser:appuser /usr/src/app
USER appuser

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
