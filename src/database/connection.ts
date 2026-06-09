/**
 * Module de connexion a la base de donnees MySQL
 *
 * Ce module gere la connexion a la base de donnees Kbine en mode lecture seule.
 * Il utilise un pool de connexions pour optimiser les performances et eviter
 * d'ouvrir une nouvelle connexion a chaque requete.
 *
 * SECURITE:
 * - L'utilisateur MySQL (kbine_readonly) n'a que les droits SELECT
 * - Aucune operation d'ecriture (INSERT, UPDATE, DELETE) n'est possible
 * - Le timeout est configure pour eviter les requetes longues
 *
 * CONFIGURATION:
 * Les parametres de connexion sont lus depuis les variables d'environnement:
 * - DB_HOST: Adresse du serveur MySQL (par defaut: kbine-mysql pour Docker)
 * - DB_PORT: Port MySQL (par defaut: 3306)
 * - DB_USER: Utilisateur MySQL (par defaut: kbine_readonly)
 * - DB_PASSWORD: Mot de passe de l'utilisateur
 * - DB_NAME: Nom de la base de donnees (par defaut: kbine_db)
 */

import mysql, { Pool, PoolOptions, RowDataPacket } from "mysql2/promise";

/**
 * Configuration du pool de connexions MySQL
 *
 * Le pool permet de reutiliser les connexions existantes plutot que
 * d'en creer de nouvelles a chaque requete. Cela ameliore les performances
 * et reduit la charge sur le serveur MySQL.
 */
const poolConfig: PoolOptions = {
  // Adresse du serveur MySQL
  // En Docker, utiliser le nom du service (kbine-mysql)
  // En local, utiliser localhost ou l'IP du serveur
  host: process.env.DB_HOST || "kbine-mysql",

  // Port MySQL standard
  port: parseInt(process.env.DB_PORT || "3306", 10),

  // Utilisateur avec droits SELECT uniquement
  // Cet utilisateur ne peut pas modifier les donnees
  user: process.env.DB_USER || "kbine_readonly",

  // Mot de passe de l'utilisateur
  // IMPORTANT: Ne jamais commiter ce mot de passe dans le code
  password: process.env.DB_PASSWORD,

  // Nom de la base de donnees Kbine
  database: process.env.DB_NAME || "kbine_db",

  // Attendre qu'une connexion soit disponible si le pool est plein
  // plutot que de retourner une erreur immediatement
  waitForConnections: true,

  // Nombre maximum de connexions simultanees dans le pool
  // 5 connexions suffisent pour les besoins de reporting
  // Augmenter si necessaire mais attention a la charge MySQL
  connectionLimit: 5,

  // Nombre maximum de requetes en attente (0 = illimite)
  // Les requetes au-dela de cette limite seront rejetees
  queueLimit: 0,

  // Timeout de connexion en millisecondes (10 secondes)
  // Si la connexion n'est pas etablie dans ce delai, une erreur est levee
  connectTimeout: 10000,

  // Activer le support des dates MySQL en tant qu'objets Date JavaScript
  // Utile pour le formatage des rapports
  dateStrings: false,

  // Timezone pour les conversions de dates
  // UTC pour eviter les problemes de fuseau horaire
  timezone: "Z",
};

/**
 * Pool de connexions MySQL
 *
 * Ce pool est cree une seule fois au demarrage du serveur et reutilise
 * pour toutes les requetes. Il gere automatiquement:
 * - La creation de nouvelles connexions si necessaire
 * - La liberation des connexions apres utilisation
 * - La reconnexion en cas de perte de connexion
 */
export const pool: Pool = mysql.createPool(poolConfig);

/**
 * Execute une requete SQL SELECT avec des parametres
 *
 * Cette fonction est le point d'entree principal pour executer des requetes.
 * Elle ajoute automatiquement une limite de resultats pour eviter
 * les requetes qui retournent trop de donnees.
 *
 * SECURITE:
 * - Utilise des requetes preparees pour eviter les injections SQL
 * - Les parametres sont echappes automatiquement par mysql2
 * - La limite de resultats protege contre les requetes abusives
 *
 * @param sql - La requete SQL a executer (doit etre un SELECT)
 * @param params - Les parametres de la requete (optionnel)
 * @param limit - Nombre maximum de resultats (par defaut: 1000)
 * @returns Les lignes resultantes de la requete
 *
 * @example
 * // Requete simple
 * const orders = await executeQuery("SELECT * FROM orders WHERE status = ?", ["success"]);
 *
 * @example
 * // Requete avec limite personnalisee
 * const topPlans = await executeQuery("SELECT * FROM plans ORDER BY price DESC", [], 10);
 */
export async function executeQuery<T extends RowDataPacket[]>(
  sql: string,
  params: (string | number | Date | null)[] = [],
  limit: number = 1000,
): Promise<T> {
  // Verification de securite: la requete doit commencer par SELECT
  // Cela empeche l'execution de requetes de modification meme si
  // l'utilisateur MySQL a des droits supplementaires par erreur
  const normalizedSql = sql.trim().toUpperCase();
  if (!normalizedSql.startsWith("SELECT")) {
    throw new Error(
      "Seules les requetes SELECT sont autorisees. " +
        "Les operations de modification (INSERT, UPDATE, DELETE) sont interdites.",
    );
  }

  // Verification que la requete ne contient pas de mots-cles dangereux
  // Meme si l'utilisateur n'a que des droits SELECT, cette verification
  // ajoute une couche de securite supplementaire
  const forbiddenKeywords = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "CREATE",
    "GRANT",
    "REVOKE",
  ];

  for (const keyword of forbiddenKeywords) {
    // Recherche du mot-cle comme mot complet (pas dans un nom de colonne)
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(sql)) {
      throw new Error(
        `Mot-cle interdit detecte: ${keyword}. ` +
          "Seules les requetes SELECT pures sont autorisees.",
      );
    }
  }

  // Ajout automatique d'une limite si la requete n'en a pas deja une
  // Cela protege contre les requetes qui retournent des millions de lignes
  const hasLimit = /\bLIMIT\s+\d+/i.test(sql);
  const finalSql = hasLimit ? sql : `${sql} LIMIT ${limit}`;

  // Log de la requete pour audit (sans les valeurs des parametres pour la securite)
  const timestamp = new Date().toISOString();
  console.log(
    `[${timestamp}] Execution requete: ${finalSql.substring(0, 200)}...`,
  );

  try {
    // Execution de la requete avec les parametres
    // mysql2 echappe automatiquement les parametres pour eviter les injections SQL
    const [rows] = await pool.execute<T>(finalSql, params);

    // Log du nombre de resultats pour monitoring
    console.log(`[${timestamp}] Resultats: ${rows.length} lignes`);

    return rows;
  } catch (error) {
    // Log de l'erreur avec details pour le debugging
    console.error(`[${timestamp}] Erreur SQL:`, error);

    // Re-throw avec un message plus clair pour l'utilisateur
    if (error instanceof Error) {
      throw new Error(
        `Erreur lors de l'execution de la requete: ${error.message}`,
      );
    }
    throw error;
  }
}

/**
 * Verifie que la connexion a la base de donnees fonctionne
 *
 * Cette fonction est utile pour:
 * - Le health check du serveur
 * - La verification au demarrage
 * - Le diagnostic en cas de probleme
 *
 * @returns true si la connexion fonctionne, false sinon
 */
export async function testConnection(): Promise<boolean> {
  try {
    // Requete simple pour verifier la connexion
    const [rows] = await pool.execute<RowDataPacket[]>("SELECT 1 AS ping");
    return rows.length > 0;
  } catch (error) {
    console.error("Erreur de connexion a la base de donnees:", error);
    return false;
  }
}

/**
 * Ferme proprement le pool de connexions
 *
 * A appeler lors de l'arret du serveur pour liberer les ressources.
 * Les connexions actives seront terminees proprement.
 */
export async function closePool(): Promise<void> {
  console.log("Fermeture du pool de connexions MySQL...");
  await pool.end();
  console.log("Pool de connexions ferme.");
}
