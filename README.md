# Kbine MCP Server

Serveur MCP (Model Context Protocol) pour interroger la base de donnees Kbine en lecture seule via Claude Desktop ou Claude Mobile.

## Objectif

Permettre au client (M. Emmanuel) de generer ses propres rapports de maniere autonome, sans intervention technique. Le serveur expose des outils de reporting et de diagnostic accessibles directement depuis Claude.

## Outils disponibles

### Rapports

| Outil | Description |
|-------|-------------|
| `rapport_mensuel` | Bilan mensuel par operateur et par plan |
| `rapport_journalier` | Bilan d'une journee avec plage horaire optionnelle |
| `rapport_periode` | Bilan entre deux dates |
| `stats_operateurs` | Repartition par operateur |
| `top_plans` | Classement des plans les plus vendus |
| `evolution_ca` | Evolution du chiffre d'affaires |

### Diagnostics

| Outil | Description |
|-------|-------------|
| `paiements_pending` | Liste des paiements bloques |
| `paiement_client` | Historique d'un client specifique |
| `statut_commande` | Detail complet d'une commande |

### Requetes personnalisees

| Outil | Description |
|-------|-------------|
| `requete_sql` | Execute une requete SELECT personnalisee |
| `aide_schema` | Affiche la documentation des tables |

## Installation

### Prerequis

- Node.js >= 18.x
- Docker et Docker Compose (pour le developpement local)

### Developpement local

```bash
# Cloner le repository
git clone https://github.com/GueuAlex/kbine-mcp-server.git
cd kbine-mcp-server

# Installer les dependances
npm install

# Demarrer avec Docker (base de donnees incluse)
docker compose up -d

# Ou demarrer en mode developpement (necessite une BDD externe)
cp .env.example .env
# Editer .env avec vos credentials
npm run dev
```

### Production

```bash
# Sur le serveur
cd /var/www
git clone https://github.com/GueuAlex/kbine-mcp-server.git
cd kbine-mcp-server

# Configurer l'environnement
cp .env.example .env
nano .env  # Remplir avec les vrais credentials

# Builder et demarrer
docker compose -f docker-compose.prod.yml up -d --build
```

## Configuration Claude Desktop

Ajouter dans `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kbine-reports": {
      "url": "https://mcp.kbine-mobile.com/sse",
      "transport": "sse"
    }
  }
}
```

## Securite

- L'utilisateur MySQL (`kbine_readonly`) n'a que des droits SELECT
- Les requetes sont validees et les mots-cles dangereux sont bloques
- Les donnees sensibles (mots de passe, tokens) ne sont pas exposees
- Une limite de resultats est appliquee automatiquement

## Structure du projet

```
kbine-mcp-server/
├── src/
│   ├── index.ts           # Point d'entree avec Express + SSE
│   ├── database/
│   │   └── connection.ts  # Pool MySQL et helpers
│   ├── tools/
│   │   ├── index.ts       # Export des outils
│   │   ├── reports.ts     # Outils de rapports
│   │   ├── diagnostics.ts # Outils de diagnostic
│   │   └── queries.ts     # Requetes personnalisees
│   └── utils/
│       └── formatters.ts  # Formatage des resultats
├── scripts/
│   └── init-dev-db.sql    # Script d'init pour dev
├── Dockerfile
├── docker-compose.yml     # Dev local
├── docker-compose.prod.yml # Production
└── README.md
```

## Endpoints HTTP

| Endpoint | Methode | Description |
|----------|---------|-------------|
| `/health` | GET | Health check |
| `/sse` | GET | Connexion SSE pour MCP |
| `/messages` | POST | Reception des messages MCP |

## Licence

Projet prive - Tous droits reserves
