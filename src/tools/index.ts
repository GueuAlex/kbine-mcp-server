/**
 * Point d'entree des outils MCP
 *
 * Ce module exporte tous les outils disponibles et fournit
 * une fonction pour les enregistrer aupres du serveur MCP.
 *
 * ORGANISATION DES OUTILS:
 *
 * 1. RAPPORTS (reports.ts)
 *    - rapport_mensuel: Bilan mensuel par operateur/plan
 *    - rapport_journalier: Bilan journalier avec plage horaire
 *    - rapport_periode: Bilan entre deux dates
 *    - stats_operateurs: Repartition par operateur
 *    - top_plans: Plans les plus vendus
 *    - evolution_ca: Evolution du chiffre d'affaires
 *
 * 2. DIAGNOSTICS (diagnostics.ts)
 *    - paiements_pending: Paiements bloques
 *    - paiement_client: Historique client
 *    - statut_commande: Detail d'une commande
 *
 * 3. REQUETES (queries.ts)
 *    - requete_sql: Requetes SELECT personnalisees
 *    - aide_schema: Documentation des tables
 *
 * AJOUT D'UN NOUVEL OUTIL:
 * 1. Creer la fonction dans le fichier approprie (reports, diagnostics, queries)
 * 2. Ajouter la definition dans l'objet xxxTools du fichier
 * 3. L'outil sera automatiquement disponible via getAllTools()
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { reportTools } from "./reports.js";
import { diagnosticTools } from "./diagnostics.js";
import { queryTools } from "./queries.js";

/**
 * Interface pour la definition d'un outil MCP
 *
 * Chaque outil doit avoir:
 * - description: Texte expliquant ce que fait l'outil
 * - inputSchema: Schema JSON des parametres
 * - handler: Fonction qui execute l'outil
 */
interface ToolDefinition {
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
  handler: (args: unknown) => Promise<string>;
}

/**
 * Combine tous les outils dans un seul objet
 *
 * Cette fonction regroupe les outils de tous les modules
 * pour les enregistrer facilement aupres du serveur MCP.
 */
function getAllTools(): Record<string, ToolDefinition> {
  return {
    ...reportTools,
    ...diagnosticTools,
    ...queryTools,
  };
}

/**
 * Configure les handlers d'outils sur le serveur MCP
 *
 * Cette fonction enregistre deux handlers:
 *
 * 1. tools/list: Retourne la liste de tous les outils disponibles
 *    avec leur description et schema de parametres.
 *    Appele par Claude pour savoir quels outils utiliser.
 *
 * 2. tools/call: Execute un outil specifique avec les arguments fournis.
 *    Appele par Claude quand l'utilisateur demande une action.
 *
 * @param server - L'instance du serveur MCP
 */
export function setupTools(server: Server): void {
  const allTools = getAllTools();

  // Handler pour lister les outils disponibles
  // Claude appelle cette methode pour decouvrir les capacites du serveur
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = Object.entries(allTools).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    // Log pour monitoring
    console.log(`[MCP] Liste des outils demandee. ${tools.length} outils disponibles.`);

    return { tools };
  });

  // Handler pour executer un outil
  // Claude appelle cette methode quand l'utilisateur fait une demande
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Log de la demande pour audit
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] Appel outil: ${name}`);
    console.log(`[${timestamp}] Arguments:`, JSON.stringify(args, null, 2));

    // Verifier que l'outil existe
    const tool = allTools[name];
    if (!tool) {
      console.error(`[${timestamp}] Outil inconnu: ${name}`);
      return {
        content: [
          {
            type: "text",
            text: `Erreur: Outil inconnu "${name}".\n\nOutils disponibles:\n${Object.keys(allTools).map(t => `- ${t}`).join("\n")}`,
          },
        ],
        isError: true,
      };
    }

    try {
      // Executer l'outil avec les arguments
      const result = await tool.handler(args);

      // Log du succes
      console.log(`[${timestamp}] Outil ${name} execute avec succes.`);

      return {
        content: [
          {
            type: "text",
            text: result,
          },
        ],
      };
    } catch (error) {
      // Gestion des erreurs
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[${timestamp}] Erreur outil ${name}:`, error);

      return {
        content: [
          {
            type: "text",
            text: `Erreur lors de l'execution de l'outil "${name}":\n\n${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Log de confirmation
  console.log(`[MCP] ${Object.keys(allTools).length} outils enregistres:`);
  for (const name of Object.keys(allTools)) {
    console.log(`  - ${name}`);
  }
}

/**
 * Exporte la liste des noms d'outils pour reference
 */
export const toolNames = Object.keys(getAllTools());
