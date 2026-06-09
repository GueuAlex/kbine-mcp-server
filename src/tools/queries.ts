/**
 * Outil MCP pour les requetes SQL personnalisees
 *
 * Ce module permet d'executer des requetes SQL SELECT personnalisees
 * avec des garde-fous de securite pour eviter les abus.
 *
 * SECURITE:
 * - Seules les requetes SELECT sont autorisees
 * - Les mots-cles dangereux (INSERT, DELETE, etc.) sont bloques
 * - Une limite automatique est ajoutee si absente
 * - L'utilisateur MySQL n'a que des droits SELECT (double securite)
 *
 * USAGE:
 * Cet outil est destine aux requetes ad-hoc qui ne sont pas couvertes
 * par les outils de rapport predefinies. Il offre plus de flexibilite
 * mais necessite des connaissances SQL basiques.
 */

import { z } from "zod";
import { RowDataPacket } from "mysql2/promise";
import { executeQuery } from "../database/connection.js";
import { toMarkdownTable } from "../utils/formatters.js";

/**
 * Liste des mots-cles SQL interdits
 *
 * Ces mots-cles sont bloques meme si l'utilisateur MySQL n'a pas
 * les droits correspondants. Cela ajoute une couche de securite
 * supplementaire en cas de mauvaise configuration des droits.
 */
const FORBIDDEN_KEYWORDS = [
  // Modification de donnees
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "MERGE",

  // Modification de structure
  "DROP",
  "ALTER",
  "CREATE",
  "TRUNCATE",
  "RENAME",

  // Administration
  "GRANT",
  "REVOKE",
  "FLUSH",
  "RESET",
  "PURGE",

  // Execution de code
  "EXECUTE",
  "CALL",
  "PREPARE",

  // Fichiers et systeme
  "LOAD",
  "OUTFILE",
  "DUMPFILE",

  // Variables et transactions
  "SET",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",

  // Verrouillage
  "LOCK",
  "UNLOCK",
];

/**
 * Liste des tables autorisees pour les requetes
 *
 * Seules ces tables peuvent etre interrogees.
 * Cela empeche l'acces a d'eventuelles tables sensibles
 * comme les tables de configuration ou de logs.
 */
const ALLOWED_TABLES = [
  "orders",
  "payments",
  "operators",
  "plans",
  "users",
  "v_users_safe", // Vue securisee des utilisateurs
];

/**
 * Limite maximale de resultats
 *
 * Cette limite empeche les requetes qui retourneraient
 * des millions de lignes et surchargeraient le serveur.
 */
const MAX_RESULTS = 1000;
const ABSOLUTE_MAX_RESULTS = 10000;

/**
 * Schema de validation pour les requetes SQL personnalisees
 */
const requeteSqlSchema = z.object({
  sql: z
    .string()
    .min(10, "La requete doit contenir au moins 10 caracteres")
    .max(5000, "La requete ne peut pas depasser 5000 caracteres"),
  limite: z.number().int().min(1).max(ABSOLUTE_MAX_RESULTS).optional(),
});

/**
 * Execute une requete SQL SELECT personnalisee
 *
 * Cette fonction permet d'executer des requetes SELECT arbitraires
 * avec plusieurs niveaux de validation et de securite:
 *
 * 1. Validation syntaxique: la requete doit commencer par SELECT
 * 2. Validation des mots-cles: aucun mot-cle dangereux autorise
 * 3. Validation des tables: seules les tables autorisees
 * 4. Limite automatique: ajout de LIMIT si absent
 * 5. Timeout: les requetes trop longues sont interrompues
 *
 * @param args - Arguments contenant la requete SQL et la limite optionnelle
 * @returns Les resultats formates en tableau Markdown
 */
export async function requeteSql(args: unknown): Promise<string> {
  // Validation des parametres
  const { sql, limite } = requeteSqlSchema.parse(args);

  // Normaliser la requete pour l'analyse
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();

  // VERIFICATION 1: La requete doit commencer par SELECT
  if (!upperSql.startsWith("SELECT")) {
    return (
      "ERREUR: La requete doit commencer par SELECT.\n\n" +
      "Seules les requetes de lecture sont autorisees. " +
      "Les operations de modification (INSERT, UPDATE, DELETE) sont interdites."
    );
  }

  // VERIFICATION 2: Pas de mots-cles interdits
  for (const keyword of FORBIDDEN_KEYWORDS) {
    // Recherche du mot-cle comme mot complet
    // Utilise les bornes de mots pour eviter les faux positifs
    // (ex: "UPDATED_AT" ne doit pas declencher "UPDATE")
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(normalizedSql)) {
      return (
        `ERREUR: Mot-cle interdit detecte: ${keyword}\n\n` +
        "Cette requete contient une operation non autorisee. " +
        "Seules les requetes SELECT pures sont autorisees."
      );
    }
  }

  // VERIFICATION 3: Verifier que seules les tables autorisees sont utilisees
  // Cette verification est basique et peut etre contournee par des requetes complexes
  // mais l'utilisateur MySQL n'a de toute facon acces qu'a ces tables
  const tablePattern = /\bFROM\s+(\w+)|\bJOIN\s+(\w+)/gi;
  const matches = normalizedSql.matchAll(tablePattern);

  for (const match of matches) {
    const tableName = (match[1] || match[2])?.toLowerCase();
    if (tableName && !ALLOWED_TABLES.includes(tableName)) {
      return (
        `ERREUR: Table non autorisee: ${tableName}\n\n` +
        `Tables autorisees: ${ALLOWED_TABLES.join(", ")}\n\n` +
        "Verifiez le nom de la table ou utilisez une des tables autorisees."
      );
    }
  }

  // VERIFICATION 4: Verifier et ajuster la limite
  const effectiveLimit = limite || MAX_RESULTS;
  const hasLimit = /\bLIMIT\s+\d+/i.test(normalizedSql);

  let finalSql = normalizedSql;
  if (!hasLimit) {
    // Ajouter la limite si absente
    finalSql = `${normalizedSql} LIMIT ${effectiveLimit}`;
  } else {
    // Verifier que la limite existante n'est pas trop grande
    const limitMatch = normalizedSql.match(/\bLIMIT\s+(\d+)/i);
    if (limitMatch) {
      const existingLimit = parseInt(limitMatch[1] || "0", 10);
      if (existingLimit > ABSOLUTE_MAX_RESULTS) {
        return (
          `ERREUR: Limite trop elevee: ${existingLimit}\n\n` +
          `La limite maximale autorisee est ${ABSOLUTE_MAX_RESULTS} lignes. ` +
          "Reduisez la limite ou utilisez des filtres pour affiner les resultats."
        );
      }
    }
  }

  // Log de la requete pour audit
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Requete personnalisee: ${finalSql.substring(0, 200)}...`);

  try {
    // Execution de la requete
    // La fonction executeQuery ajoute deja des validations supplementaires
    const rows = await executeQuery<RowDataPacket[]>(finalSql, [], effectiveLimit);

    // Si aucun resultat
    if (rows.length === 0) {
      return (
        "La requete n'a retourne aucun resultat.\n\n" +
        "Verifiez que:\n" +
        "- Les conditions de filtrage sont correctes\n" +
        "- Les donnees existent pour la periode demandee"
      );
    }

    // Formater les resultats en tableau Markdown
    const tableau = toMarkdownTable(rows);

    // Construire la reponse
    const infoLimite = hasLimit
      ? ""
      : `\n\n*Note: Une limite de ${effectiveLimit} resultats a ete appliquee automatiquement.*`;

    return (
      `# Resultat de la requete\n\n` +
      `Nombre de lignes: ${rows.length}${infoLimite}\n\n` +
      tableau
    );
  } catch (error) {
    // Gestion des erreurs SQL
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log de l'erreur pour debug
    console.error(`[${timestamp}] Erreur requete personnalisee:`, error);

    return (
      `ERREUR lors de l'execution de la requete:\n\n` +
      `${errorMessage}\n\n` +
      "Verifiez la syntaxe SQL et les noms de colonnes."
    );
  }
}

/**
 * Affiche l'aide sur les tables et colonnes disponibles
 *
 * Cette fonction liste les tables autorisees et leurs colonnes principales
 * pour aider l'utilisateur a construire ses requetes.
 *
 * @returns Documentation des tables disponibles
 */
export async function aideSchema(): Promise<string> {
  // Cette documentation est statique car le schema ne change pas souvent
  // et evite une requete supplementaire a la base de donnees
  const schema = `
# Schema de la base de donnees Kbine

## Tables disponibles

### orders (Commandes)
| Colonne | Type | Description |
| --- | --- | --- |
| id | INT | Identifiant unique |
| order_reference | VARCHAR | Reference (ORD-YYYYMMDD-XXXXX) |
| user_id | INT | ID du client |
| plan_id | INT | ID du plan (null si transfert direct) |
| phone_number | VARCHAR | Numero a recharger |
| amount | DECIMAL | Montant de la commande |
| status | ENUM | pending, processing, success, failed |
| created_at | DATETIME | Date de creation |
| updated_at | DATETIME | Date de mise a jour |

### payments (Paiements)
| Colonne | Type | Description |
| --- | --- | --- |
| id | INT | Identifiant unique |
| order_id | INT | ID de la commande |
| payment_reference | VARCHAR | Reference du paiement |
| external_reference | VARCHAR | Reference TouchPoint |
| payment_method | VARCHAR | wave, mtn, orange, moov |
| payment_phone | VARCHAR | Numero de paiement |
| amount | DECIMAL | Montant paye |
| status | ENUM | pending, success, failed |
| created_at | DATETIME | Date de creation |
| updated_at | DATETIME | Date de mise a jour |

### operators (Operateurs)
| Colonne | Type | Description |
| --- | --- | --- |
| id | INT | Identifiant unique |
| name | VARCHAR | Nom (Orange, MTN, Moov) |
| code | VARCHAR | Code operateur |
| prefixes | JSON | Prefixes telephone |

### plans (Plans/Forfaits)
| Colonne | Type | Description |
| --- | --- | --- |
| id | INT | Identifiant unique |
| operator_id | INT | ID de l'operateur |
| name | VARCHAR | Nom du plan |
| description | TEXT | Description |
| price | DECIMAL | Prix |
| type | VARCHAR | Type de plan |
| validity_days | INT | Duree de validite |

### users (Utilisateurs) - via v_users_safe
| Colonne | Type | Description |
| --- | --- | --- |
| id | INT | Identifiant unique |
| full_name | VARCHAR | Nom complet |
| phone_number | VARCHAR | Telephone |
| created_at | DATETIME | Date d'inscription |

*Note: Les colonnes sensibles (password, email, tokens) ne sont pas accessibles.*

## Exemples de requetes

### Commandes d'aujourd'hui
\`\`\`sql
SELECT * FROM orders WHERE DATE(created_at) = CURDATE()
\`\`\`

### Paiements reussis ce mois
\`\`\`sql
SELECT * FROM payments
WHERE status = 'success'
  AND MONTH(created_at) = MONTH(CURDATE())
\`\`\`

### Plans par operateur
\`\`\`sql
SELECT p.name, p.price, o.name AS operateur
FROM plans p
JOIN operators o ON p.operator_id = o.id
\`\`\`

### Total par methode de paiement
\`\`\`sql
SELECT payment_method, COUNT(*) AS nombre, SUM(amount) AS total
FROM payments
WHERE status = 'success' AND DATE(created_at) = CURDATE()
GROUP BY payment_method
\`\`\`
`;

  return schema.trim();
}

/**
 * Definitions des outils de requetes pour le serveur MCP
 */
export const queryTools = {
  requete_sql: {
    description:
      "Execute une requete SQL SELECT personnalisee. " +
      "Permet des analyses ad-hoc non couvertes par les rapports predefinies. " +
      "Seules les requetes SELECT sont autorisees.",
    inputSchema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "La requete SQL a executer (doit commencer par SELECT). " +
            "Tables autorisees: orders, payments, operators, plans, users (v_users_safe).",
        },
        limite: {
          type: "number",
          description: "Nombre maximum de resultats (defaut: 1000, max: 10000)",
        },
      },
      required: ["sql"],
    },
    handler: requeteSql,
  },

  aide_schema: {
    description:
      "Affiche la documentation des tables et colonnes disponibles " +
      "pour aider a construire des requetes SQL personnalisees.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
    handler: aideSchema,
  },
};
