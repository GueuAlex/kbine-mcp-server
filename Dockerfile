# =============================================================================
# Dockerfile - Kbine MCP Server
# =============================================================================
#
# Ce Dockerfile construit l'image du serveur MCP Kbine Reports.
# Le serveur permet d'interroger la base de donnees Kbine en lecture seule
# via le protocole MCP (Model Context Protocol).
#
# CONSTRUCTION:
#   docker build -t kbine-mcp-server .
#
# EXECUTION:
#   docker run -p 3001:3001 --env-file .env kbine-mcp-server
#
# MULTI-STAGE BUILD:
#   - Stage 1 (builder): Compile le TypeScript en JavaScript
#   - Stage 2 (production): Image minimale avec seulement le code compile
#
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder
# Compile le TypeScript et installe toutes les dependances
# -----------------------------------------------------------------------------
FROM node:18-alpine AS builder

# Definir le repertoire de travail
WORKDIR /app

# Copier les fichiers de configuration npm
# Copier separement pour profiter du cache Docker
COPY package.json package-lock.json* ./

# Installer toutes les dependances (y compris devDependencies pour tsc)
RUN npm ci

# Copier le code source
COPY tsconfig.json ./
COPY src/ ./src/

# Compiler TypeScript en JavaScript
# Le resultat est dans le dossier dist/
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 2: Production
# Image minimale avec seulement le code compile et les dependances de production
# -----------------------------------------------------------------------------
FROM node:18-alpine AS production

# Metadonnees de l'image
LABEL maintainer="GueuAlex"
LABEL description="Serveur MCP pour interroger la base de donnees Kbine"
LABEL version="1.0.0"

# Creer un utilisateur non-root pour la securite
# L'application ne doit pas tourner en tant que root
RUN addgroup -g 1001 -S kbine && \
    adduser -S -D -H -u 1001 -h /app -s /sbin/nologin -G kbine kbine

# Definir le repertoire de travail
WORKDIR /app

# Copier les fichiers de configuration npm
COPY package.json package-lock.json* ./

# Installer seulement les dependances de production
# --omit=dev: exclut les devDependencies (typescript, etc.)
# --ignore-scripts: securite, n'execute pas les scripts postinstall
RUN npm ci --omit=dev --ignore-scripts && \
    npm cache clean --force

# Copier le code compile depuis le stage builder
COPY --from=builder /app/dist ./dist

# Changer le proprietaire des fichiers
RUN chown -R kbine:kbine /app

# Utiliser l'utilisateur non-root
USER kbine

# Exposer le port du serveur
# Le port peut etre change via la variable PORT
EXPOSE 3001

# Variables d'environnement par defaut
# Ces valeurs peuvent etre surchargees au runtime
ENV NODE_ENV=production
ENV PORT=3001

# Health check pour Docker et les orchestrateurs
# Verifie que le serveur repond correctement
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Commande de demarrage
# Utilise node directement (pas npm) pour un meilleur signal handling
CMD ["node", "dist/index.js"]
