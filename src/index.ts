/**
 * Point d'entree du serveur MCP Kbine Reports
 *
 * Ce serveur MCP permet a M. Emmanuel d'interroger la base de donnees Kbine
 * en lecture seule depuis Claude Desktop ou Claude Mobile.
 *
 * ARCHITECTURE:
 * - Express.js pour le serveur HTTP
 * - SSE (Server-Sent Events) pour le transport MCP
 * - MySQL pour la base de donnees (connexion read-only)
 *
 * ENDPOINTS:
 * - GET /health: Health check pour monitoring
 * - GET /sse: Endpoint SSE pour la connexion MCP
 * - POST /messages: Endpoint pour les messages MCP (utilise par SSE)
 *
 * SECURITE:
 * - L'utilisateur MySQL n'a que des droits SELECT
 * - Les requetes sont validees et limitees
 * - Les donnees sensibles ne sont pas exposees
 *
 * DEMARRAGE:
 * 1. Charger les variables d'environnement
 * 2. Verifier la connexion a la base de donnees
 * 3. Demarrer le serveur Express
 * 4. Attendre les connexions MCP
 */

import "dotenv/config";
import express, { Request, Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

import { testConnection, closePool } from "./database/connection.js";
import { setupTools } from "./tools/index.js";

/**
 * Configuration du serveur
 *
 * Le port peut etre configure via la variable d'environnement PORT.
 * Par defaut, le serveur ecoute sur le port 3001.
 */
const PORT = parseInt(process.env.PORT || "3001", 10);
const NODE_ENV = process.env.NODE_ENV || "development";

/**
 * Application Express
 *
 * Express est utilise comme serveur HTTP pour:
 * - Exposer l'endpoint SSE pour MCP
 * - Fournir un health check
 * - Gerer les erreurs HTTP
 */
const app = express();

/**
 * Middleware pour parser le JSON
 *
 * Necessaire pour recevoir les messages MCP via POST /messages
 */
app.use(express.json());

/**
 * Middleware de logging des requetes
 *
 * Log toutes les requetes entrantes pour le monitoring et le debug.
 * En production, ces logs sont utiles pour l'audit.
 */
app.use((req: Request, _res: Response, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path}`);
  next();
});

/**
 * Health check endpoint
 *
 * Utilise par:
 * - Le load balancer pour verifier que le serveur est up
 * - Docker pour le healthcheck du container
 * - Le monitoring pour alerter en cas de probleme
 *
 * Retourne:
 * - status: "OK" si tout va bien
 * - service: Nom du service
 * - environment: Environnement (development/production)
 * - database: Etat de la connexion MySQL
 */
app.get("/health", async (_req: Request, res: Response) => {
  const dbConnected = await testConnection();

  const status = {
    status: dbConnected ? "OK" : "DEGRADED",
    service: "kbine-mcp-server",
    version: "1.0.0",
    environment: NODE_ENV,
    database: dbConnected ? "connected" : "disconnected",
    timestamp: new Date().toISOString(),
  };

  // Code HTTP 200 si OK, 503 si la BDD est deconnectee
  const httpCode = dbConnected ? 200 : 503;
  res.status(httpCode).json(status);
});

/**
 * Stockage des transports SSE actifs
 *
 * Chaque connexion SSE est associee a un transport.
 * Cette map permet de retrouver le transport pour envoyer
 * des messages de reponse.
 *
 * Cle: ID de session (genere aleatoirement)
 * Valeur: Transport SSE
 */
const transports = new Map<string, SSEServerTransport>();

/**
 * Endpoint SSE pour les connexions MCP
 *
 * Cet endpoint est utilise par Claude Desktop/Mobile pour se connecter
 * au serveur MCP. La connexion reste ouverte et utilise SSE pour
 * la communication bidirectionnelle.
 *
 * Processus:
 * 1. Le client se connecte a /sse
 * 2. Un nouveau serveur MCP est cree pour cette connexion
 * 3. Les outils sont enregistres sur le serveur
 * 4. Le transport SSE maintient la connexion ouverte
 * 5. Les messages sont echanges via SSE
 */
app.get("/sse", async (_req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Nouvelle connexion SSE`);

  // Configurer les headers pour SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  // Permettre les connexions cross-origin (pour Claude Mobile)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Creer le transport SSE
  // Le chemin /messages est utilise pour les messages entrants
  const transport = new SSEServerTransport("/messages", res);

  // Generer un ID unique pour cette session
  const sessionId = Math.random().toString(36).substring(2, 15);
  transports.set(sessionId, transport);

  console.log(`[${timestamp}] Session SSE creee: ${sessionId}`);

  // Creer le serveur MCP pour cette connexion
  const server = new Server(
    {
      name: "kbine-reports",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Enregistrer les outils sur le serveur
  setupTools(server);

  // Gerer la fermeture de la connexion
  res.on("close", () => {
    console.log(`[${new Date().toISOString()}] Connexion SSE fermee: ${sessionId}`);
    transports.delete(sessionId);
  });

  // Connecter le transport au serveur MCP
  try {
    await server.connect(transport);
    console.log(`[${timestamp}] Serveur MCP connecte pour session ${sessionId}`);
  } catch (error) {
    console.error(`[${timestamp}] Erreur connexion MCP:`, error);
    transports.delete(sessionId);
  }
});

/**
 * Endpoint pour recevoir les messages MCP
 *
 * Les messages du client Claude sont envoyes via POST a cet endpoint.
 * Le transport SSE correspondant est utilise pour traiter le message
 * et envoyer la reponse.
 *
 * Note: Cet endpoint est appele par le transport SSE lui-meme,
 * pas directement par le client.
 */
app.post("/messages", async (req: Request, res: Response) => {
  const timestamp = new Date().toISOString();

  // Recuperer le transport associe (le premier pour simplifier)
  // En production avec plusieurs clients, il faudrait un systeme
  // d'identification de session plus robuste
  const transport = transports.values().next().value as SSEServerTransport | undefined;

  if (!transport) {
    console.error(`[${timestamp}] Aucun transport SSE actif pour traiter le message`);
    res.status(503).json({
      error: "No active SSE connection",
      message: "Veuillez vous reconnecter via /sse",
    });
    return;
  }

  try {
    // Le transport gere le message et envoie la reponse via SSE
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error(`[${timestamp}] Erreur traitement message:`, error);
    res.status(500).json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * Gestion des erreurs globales
 *
 * Capture les erreurs non gerees et retourne une reponse JSON.
 */
app.use((err: Error, _req: Request, res: Response, _next: unknown) => {
  console.error("Erreur non geree:", err);
  res.status(500).json({
    error: "Internal server error",
    message: NODE_ENV === "development" ? err.message : "An error occurred",
  });
});

/**
 * Demarrage du serveur
 *
 * 1. Verifier la connexion a la base de donnees
 * 2. Demarrer le serveur Express
 * 3. Afficher les informations de connexion
 */
async function startServer(): Promise<void> {
  console.log("=".repeat(60));
  console.log("  Kbine MCP Server - Demarrage");
  console.log("=".repeat(60));
  console.log();

  // Verification de la connexion a la base de donnees
  console.log("Verification de la connexion MySQL...");
  const dbConnected = await testConnection();

  if (!dbConnected) {
    console.error("ERREUR: Impossible de se connecter a la base de donnees.");
    console.error("Verifiez les variables d'environnement:");
    console.error("  - DB_HOST");
    console.error("  - DB_PORT");
    console.error("  - DB_USER");
    console.error("  - DB_PASSWORD");
    console.error("  - DB_NAME");
    process.exit(1);
  }

  console.log("Connexion MySQL: OK");
  console.log();

  // Demarrer le serveur Express
  app.listen(PORT, () => {
    console.log("Serveur demarre avec succes!");
    console.log();
    console.log("Configuration:");
    console.log(`  - Port: ${PORT}`);
    console.log(`  - Environnement: ${NODE_ENV}`);
    console.log(`  - Base de donnees: ${process.env.DB_HOST || "kbine-mysql"}`);
    console.log();
    console.log("Endpoints:");
    console.log(`  - Health check: http://localhost:${PORT}/health`);
    console.log(`  - SSE (MCP): http://localhost:${PORT}/sse`);
    console.log();
    console.log("Configuration Claude Desktop/Mobile:");
    console.log(`  URL: https://mcp.kbine-mobile.com/sse`);
    console.log();
    console.log("=".repeat(60));
    console.log("  Serveur pret a recevoir des connexions");
    console.log("=".repeat(60));
  });
}

/**
 * Gestion de l'arret propre du serveur
 *
 * Quand le processus recoit un signal d'arret (SIGINT, SIGTERM),
 * le pool de connexions MySQL est ferme proprement avant de quitter.
 */
process.on("SIGINT", async () => {
  console.log("\nArret du serveur...");
  await closePool();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nArret du serveur (SIGTERM)...");
  await closePool();
  process.exit(0);
});

/**
 * Gestion des erreurs non capturees
 *
 * Log les erreurs mais ne fait pas planter le serveur.
 */
process.on("uncaughtException", (error) => {
  console.error("Exception non capturee:", error);
  // Ne pas quitter en production, juste logger
});

process.on("unhandledRejection", (reason) => {
  console.error("Promise rejetee non geree:", reason);
  // Ne pas quitter en production, juste logger
});

// Demarrer le serveur
startServer().catch((error) => {
  console.error("Erreur fatale au demarrage:", error);
  process.exit(1);
});
