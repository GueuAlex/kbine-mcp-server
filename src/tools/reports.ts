/**
 * Outils MCP pour la generation de rapports
 *
 * Ce module contient les outils de reporting accessibles via le protocole MCP.
 * Ces outils permettent a M. Emmanuel de generer des rapports de maniere autonome
 * depuis Claude Desktop ou Claude Mobile.
 *
 * OUTILS DISPONIBLES:
 * - rapport_mensuel: Bilan par operateur/plan pour un mois donne
 * - rapport_journalier: Bilan d'une journee avec plage horaire optionnelle
 * - rapport_periode: Bilan entre deux dates
 * - stats_operateurs: Repartition par operateur
 * - top_plans: Classement des plans les plus vendus
 * - evolution_ca: Evolution du chiffre d'affaires
 *
 * SECURITE:
 * - Toutes les requetes sont en lecture seule (SELECT)
 * - Les parametres sont valides avec Zod
 * - Les resultats sont limites pour eviter les surcharges
 */

import { z } from "zod";
import { RowDataPacket } from "mysql2/promise";
import { executeQuery } from "../database/connection.js";
import {
  toMarkdownTable,
  formatCurrency,
  formatNumber,
  formatStatsSummary,
} from "../utils/formatters.js";

/**
 * Schema de validation pour le rapport mensuel
 *
 * Le mois doit etre au format YYYY-MM (ex: 2026-05)
 */
const rapportMensuelSchema = z.object({
  mois: z
    .string()
    .regex(
      /^\d{4}-\d{2}$/,
      "Le mois doit etre au format YYYY-MM (ex: 2026-05)",
    ),
});

/**
 * Genere un rapport mensuel par operateur et par plan
 *
 * Ce rapport montre pour chaque operateur et chaque plan:
 * - Le nombre total de commandes avec paiement reussi
 * - Le montant total encaisse
 *
 * La requete prend en compte:
 * - Les commandes avec un plan (Orange, MTN, etc.)
 * - Les transferts directs (sans plan) avec detection de l'operateur via le prefixe
 *
 * @param args - Arguments contenant le mois au format YYYY-MM
 * @returns Le rapport formate en tableau Markdown
 */
export async function rapportMensuel(args: unknown): Promise<string> {
  // Validation des parametres
  const { mois } = rapportMensuelSchema.parse(args);

  // Extraction de l'annee et du mois
  const [annee, moisNum] = mois.split("-");

  // Requete SQL pour le rapport mensuel
  // Cette requete est basee sur celle documentee dans maintenan-KBINE.md
  // Elle gere a la fois les commandes avec plan et les transferts directs
  const sql = `
    SELECT
      LAST_DAY(o.created_at) AS fin_de_mois,
      COALESCE(op.name, op_direct.name, 'Inconnu') AS operateur,
      COALESCE(pl.name, 'Transfert direct') AS plan,
      COUNT(o.id) AS total_commandes,
      ROUND(SUM(o.amount), 2) AS montant_total

    FROM orders o
    INNER JOIN payments pay ON pay.order_id = o.id AND pay.status = 'success'
    LEFT JOIN plans pl ON pl.id = o.plan_id
    LEFT JOIN operators op ON op.id = pl.operator_id

    -- Pour les transferts directs: detecte l'operateur via le prefixe du numero
    -- La colonne prefixes contient un tableau JSON de prefixes (ex: ["05", "04"])
    LEFT JOIN operators op_direct ON o.plan_id IS NULL
      AND JSON_CONTAINS(op_direct.prefixes, JSON_QUOTE(LEFT(o.phone_number, 2)))

    WHERE YEAR(o.created_at) = ? AND MONTH(o.created_at) = ?

    GROUP BY
      LAST_DAY(o.created_at),
      COALESCE(op.name, op_direct.name, 'Inconnu'),
      COALESCE(pl.name, 'Transfert direct')

    ORDER BY
      operateur ASC,
      plan ASC
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, [annee, moisNum]);

  // Si aucun resultat, retourner un message explicatif
  if (rows.length === 0) {
    return `Aucune commande trouvee pour le mois de ${mois}.\n\nVerifiez que:\n- La date est correcte\n- Des commandes existent pour cette periode`;
  }

  // Calculer les totaux pour le resume
  let totalCommandes = 0;
  let montantTotal = 0;
  for (const row of rows) {
    totalCommandes += Number(row.total_commandes) || 0;
    montantTotal += Number(row.montant_total) || 0;
  }

  // Formater le rapport
  const tableau = toMarkdownTable(rows, {
    montant_total: (v) => formatCurrency(Number(v)),
    total_commandes: (v) => formatNumber(Number(v)),
  });

  // Construire la reponse avec resume
  const resume = formatStatsSummary({
    totalCommandes,
    montantTotal,
    periode: `Mois de ${mois}`,
  });

  return `# Rapport Mensuel - ${mois}\n\n${resume}\n\n## Detail par operateur et plan\n\n${tableau}`;
}

/**
 * Schema de validation pour le rapport journalier
 *
 * La date doit etre au format YYYY-MM-DD
 * Les heures sont optionnelles et au format HH:MM
 */
const rapportJournalierSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La date doit etre au format YYYY-MM-DD"),
  heure_debut: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "L'heure doit etre au format HH:MM")
    .optional(),
  heure_fin: z
    .string()
    .regex(/^\d{2}:\d{2}$/, "L'heure doit etre au format HH:MM")
    .optional(),
});

/**
 * Genere un rapport journalier avec plage horaire optionnelle
 *
 * Par defaut, le rapport couvre toute la journee.
 * Si heure_debut et heure_fin sont specifiees, seules les commandes
 * dans cette plage horaire sont incluses.
 *
 * Cas d'usage typique:
 * - Rapport de fin de journee (9h-18h)
 * - Analyse d'une periode specifique
 *
 * @param args - Arguments contenant la date et optionnellement les heures
 * @returns Le rapport formate en tableau Markdown
 */
export async function rapportJournalier(args: unknown): Promise<string> {
  // Validation des parametres
  const { date, heure_debut, heure_fin } = rapportJournalierSchema.parse(args);

  // Construction de la requete SQL avec ou sans filtre horaire
  let sql = `
    SELECT
      DATE(o.created_at) AS date,
      COALESCE(op.name, op_direct.name, 'Inconnu') AS operateur,
      COALESCE(pl.name, 'Transfert direct') AS plan,
      COUNT(o.id) AS total_commandes,
      ROUND(SUM(o.amount), 2) AS montant_total

    FROM orders o
    INNER JOIN payments pay ON pay.order_id = o.id AND pay.status = 'success'
    LEFT JOIN plans pl ON pl.id = o.plan_id
    LEFT JOIN operators op ON op.id = pl.operator_id
    LEFT JOIN operators op_direct ON o.plan_id IS NULL
      AND JSON_CONTAINS(op_direct.prefixes, JSON_QUOTE(LEFT(o.phone_number, 2)))

    WHERE DATE(o.created_at) = ?
  `;

  const params: (string | number)[] = [date];

  // Ajout du filtre horaire si specifie
  if (heure_debut && heure_fin) {
    sql += ` AND TIME(o.created_at) BETWEEN ? AND ?`;
    params.push(`${heure_debut}:00`, `${heure_fin}:00`);
  }

  sql += `
    GROUP BY
      DATE(o.created_at),
      COALESCE(op.name, op_direct.name, 'Inconnu'),
      COALESCE(pl.name, 'Transfert direct')

    ORDER BY
      operateur ASC,
      plan ASC
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, params);

  // Message si aucun resultat
  if (rows.length === 0) {
    const periodeDesc =
      heure_debut && heure_fin
        ? `le ${date} entre ${heure_debut} et ${heure_fin}`
        : `le ${date}`;
    return `Aucune commande trouvee pour ${periodeDesc}.`;
  }

  // Calculer les totaux
  let totalCommandes = 0;
  let montantTotal = 0;
  for (const row of rows) {
    totalCommandes += Number(row.total_commandes) || 0;
    montantTotal += Number(row.montant_total) || 0;
  }

  // Formater le rapport
  const tableau = toMarkdownTable(rows, {
    montant_total: (v) => formatCurrency(Number(v)),
    total_commandes: (v) => formatNumber(Number(v)),
  });

  // Description de la periode
  const periodeDesc =
    heure_debut && heure_fin ? `${date} (${heure_debut} - ${heure_fin})` : date;

  const resume = formatStatsSummary({
    totalCommandes,
    montantTotal,
    periode: periodeDesc,
  });

  return `# Rapport Journalier - ${periodeDesc}\n\n${resume}\n\n## Detail par operateur et plan\n\n${tableau}`;
}

/**
 * Schema de validation pour le rapport de periode
 */
const rapportPeriodeSchema = z.object({
  date_debut: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La date doit etre au format YYYY-MM-DD"),
  date_fin: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La date doit etre au format YYYY-MM-DD"),
});

/**
 * Genere un rapport pour une periode entre deux dates
 *
 * Ce rapport agrege les donnees jour par jour entre les deux dates.
 * Utile pour:
 * - Analyse d'une semaine specifique
 * - Comparaison entre periodes
 * - Rapports personnalises
 *
 * @param args - Arguments contenant date_debut et date_fin
 * @returns Le rapport formate en tableau Markdown
 */
export async function rapportPeriode(args: unknown): Promise<string> {
  // Validation des parametres
  const { date_debut, date_fin } = rapportPeriodeSchema.parse(args);

  // Verification que date_debut <= date_fin
  if (date_debut > date_fin) {
    return "Erreur: la date de debut doit etre anterieure ou egale a la date de fin.";
  }

  const sql = `
    SELECT
      DATE(o.created_at) AS date,
      COALESCE(op.name, op_direct.name, 'Inconnu') AS operateur,
      COUNT(o.id) AS total_commandes,
      ROUND(SUM(o.amount), 2) AS montant_total

    FROM orders o
    INNER JOIN payments pay ON pay.order_id = o.id AND pay.status = 'success'
    LEFT JOIN plans pl ON pl.id = o.plan_id
    LEFT JOIN operators op ON op.id = pl.operator_id
    LEFT JOIN operators op_direct ON o.plan_id IS NULL
      AND JSON_CONTAINS(op_direct.prefixes, JSON_QUOTE(LEFT(o.phone_number, 2)))

    WHERE DATE(o.created_at) BETWEEN ? AND ?

    GROUP BY
      DATE(o.created_at),
      COALESCE(op.name, op_direct.name, 'Inconnu')

    ORDER BY
      date ASC,
      operateur ASC
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, [date_debut, date_fin]);

  if (rows.length === 0) {
    return `Aucune commande trouvee entre le ${date_debut} et le ${date_fin}.`;
  }

  // Calculer les totaux
  let totalCommandes = 0;
  let montantTotal = 0;
  for (const row of rows) {
    totalCommandes += Number(row.total_commandes) || 0;
    montantTotal += Number(row.montant_total) || 0;
  }

  const tableau = toMarkdownTable(rows, {
    montant_total: (v) => formatCurrency(Number(v)),
    total_commandes: (v) => formatNumber(Number(v)),
  });

  const resume = formatStatsSummary({
    totalCommandes,
    montantTotal,
    periode: `Du ${date_debut} au ${date_fin}`,
  });

  return `# Rapport Periode - ${date_debut} au ${date_fin}\n\n${resume}\n\n## Detail par jour et operateur\n\n${tableau}`;
}

/**
 * Schema de validation pour les statistiques operateurs
 */
const statsOperateursSchema = z.object({
  periode: z.enum(["jour", "semaine", "mois", "annee"]),
});

/**
 * Genere des statistiques de repartition par operateur
 *
 * Montre la part de marche de chaque operateur sur la periode demandee.
 *
 * @param args - Arguments contenant la periode (jour, semaine, mois, annee)
 * @returns Les statistiques formatees
 */
export async function statsOperateurs(args: unknown): Promise<string> {
  const { periode } = statsOperateursSchema.parse(args);

  // Determiner la condition de filtre selon la periode
  let dateCondition: string;
  let periodeDesc: string;

  switch (periode) {
    case "jour":
      dateCondition = "DATE(o.created_at) = CURDATE()";
      periodeDesc = "Aujourd'hui";
      break;
    case "semaine":
      dateCondition = "YEARWEEK(o.created_at, 1) = YEARWEEK(CURDATE(), 1)";
      periodeDesc = "Cette semaine";
      break;
    case "mois":
      dateCondition =
        "YEAR(o.created_at) = YEAR(CURDATE()) AND MONTH(o.created_at) = MONTH(CURDATE())";
      periodeDesc = "Ce mois";
      break;
    case "annee":
      dateCondition = "YEAR(o.created_at) = YEAR(CURDATE())";
      periodeDesc = "Cette annee";
      break;
  }

  const sql = `
    SELECT
      COALESCE(op.name, op_direct.name, 'Inconnu') AS operateur,
      COUNT(o.id) AS total_commandes,
      ROUND(SUM(o.amount), 2) AS montant_total,
      ROUND(COUNT(o.id) * 100.0 / (
        SELECT COUNT(*) FROM orders o2
        INNER JOIN payments pay2 ON pay2.order_id = o2.id AND pay2.status = 'success'
        WHERE ${dateCondition.replace(/o\./g, "o2.")}
      ), 1) AS pourcentage_commandes

    FROM orders o
    INNER JOIN payments pay ON pay.order_id = o.id AND pay.status = 'success'
    LEFT JOIN plans pl ON pl.id = o.plan_id
    LEFT JOIN operators op ON op.id = pl.operator_id
    LEFT JOIN operators op_direct ON o.plan_id IS NULL
      AND JSON_CONTAINS(op_direct.prefixes, JSON_QUOTE(LEFT(o.phone_number, 2)))

    WHERE ${dateCondition}

    GROUP BY COALESCE(op.name, op_direct.name, 'Inconnu')
    ORDER BY total_commandes DESC
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, []);

  if (rows.length === 0) {
    return `Aucune donnee trouvee pour la periode: ${periodeDesc}`;
  }

  const tableau = toMarkdownTable(rows, {
    montant_total: (v) => formatCurrency(Number(v)),
    total_commandes: (v) => formatNumber(Number(v)),
    pourcentage_commandes: (v) => `${v}%`,
  });

  return `# Statistiques par Operateur - ${periodeDesc}\n\n${tableau}`;
}

/**
 * Schema de validation pour le top des plans
 */
const topPlansSchema = z.object({
  limite: z.number().int().min(1).max(50).optional().default(10),
  periode: z
    .enum(["jour", "semaine", "mois", "annee"])
    .optional()
    .default("mois"),
});

/**
 * Genere le classement des plans les plus vendus
 *
 * @param args - Arguments contenant la limite et la periode
 * @returns Le classement formate
 */
export async function topPlans(args: unknown): Promise<string> {
  const { limite, periode } = topPlansSchema.parse(args);

  // Condition de filtre selon la periode
  let dateCondition: string;
  let periodeDesc: string;

  switch (periode) {
    case "jour":
      dateCondition = "DATE(o.created_at) = CURDATE()";
      periodeDesc = "aujourd'hui";
      break;
    case "semaine":
      dateCondition = "YEARWEEK(o.created_at, 1) = YEARWEEK(CURDATE(), 1)";
      periodeDesc = "cette semaine";
      break;
    case "mois":
      dateCondition =
        "YEAR(o.created_at) = YEAR(CURDATE()) AND MONTH(o.created_at) = MONTH(CURDATE())";
      periodeDesc = "ce mois";
      break;
    case "annee":
      dateCondition = "YEAR(o.created_at) = YEAR(CURDATE())";
      periodeDesc = "cette annee";
      break;
  }

  const sql = `
    SELECT
      COALESCE(pl.name, 'Transfert direct') AS plan,
      COALESCE(op.name, 'N/A') AS operateur,
      COUNT(o.id) AS nombre_ventes,
      ROUND(SUM(o.amount), 2) AS chiffre_affaires

    FROM orders o
    INNER JOIN payments pay ON pay.order_id = o.id AND pay.status = 'success'
    LEFT JOIN plans pl ON pl.id = o.plan_id
    LEFT JOIN operators op ON op.id = pl.operator_id

    WHERE ${dateCondition}

    GROUP BY
      COALESCE(pl.name, 'Transfert direct'),
      COALESCE(op.name, 'N/A')

    ORDER BY nombre_ventes DESC
    LIMIT ?
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, [limite]);

  if (rows.length === 0) {
    return `Aucune vente trouvee pour la periode: ${periodeDesc}`;
  }

  const tableau = toMarkdownTable(rows, {
    chiffre_affaires: (v) => formatCurrency(Number(v)),
    nombre_ventes: (v) => formatNumber(Number(v)),
  });

  return `# Top ${limite} des Plans - ${periodeDesc}\n\n${tableau}`;
}

/**
 * Schema de validation pour l'evolution du CA
 */
const evolutionCaSchema = z.object({
  date_debut: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La date doit etre au format YYYY-MM-DD"),
  date_fin: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La date doit etre au format YYYY-MM-DD"),
  granularite: z.enum(["jour", "semaine", "mois"]).optional().default("jour"),
});

/**
 * Genere l'evolution du chiffre d'affaires sur une periode
 *
 * Permet de visualiser la tendance des ventes sur une periode donnee.
 * La granularite peut etre ajustee (jour, semaine, mois).
 *
 * @param args - Arguments contenant les dates et la granularite
 * @returns L'evolution formatee en tableau
 */
export async function evolutionCa(args: unknown): Promise<string> {
  const { date_debut, date_fin, granularite } = evolutionCaSchema.parse(args);

  // Verification des dates
  if (date_debut > date_fin) {
    return "Erreur: la date de debut doit etre anterieure a la date de fin.";
  }

  // Format de groupement selon la granularite
  let groupBy: string;
  let selectDate: string;

  switch (granularite) {
    case "jour":
      groupBy = "DATE(o.created_at)";
      selectDate = "DATE(o.created_at) AS periode";
      break;
    case "semaine":
      groupBy = "YEARWEEK(o.created_at, 1)";
      selectDate =
        "CONCAT(YEAR(o.created_at), '-S', LPAD(WEEK(o.created_at, 1), 2, '0')) AS periode";
      break;
    case "mois":
      groupBy = "YEAR(o.created_at), MONTH(o.created_at)";
      selectDate = "DATE_FORMAT(o.created_at, '%Y-%m') AS periode";
      break;
  }

  const sql = `
    SELECT
      ${selectDate},
      COUNT(o.id) AS nombre_commandes,
      ROUND(SUM(o.amount), 2) AS chiffre_affaires

    FROM orders o
    INNER JOIN payments pay ON pay.order_id = o.id AND pay.status = 'success'

    WHERE DATE(o.created_at) BETWEEN ? AND ?

    GROUP BY ${groupBy}
    ORDER BY periode ASC
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, [date_debut, date_fin]);

  if (rows.length === 0) {
    return `Aucune donnee trouvee entre le ${date_debut} et le ${date_fin}.`;
  }

  // Calculer les totaux et la moyenne
  let totalCA = 0;
  let totalCommandes = 0;
  for (const row of rows) {
    totalCA += Number(row.chiffre_affaires) || 0;
    totalCommandes += Number(row.nombre_commandes) || 0;
  }
  const moyenneCA = totalCA / rows.length;

  const tableau = toMarkdownTable(rows, {
    chiffre_affaires: (v) => formatCurrency(Number(v)),
    nombre_commandes: (v) => formatNumber(Number(v)),
  });

  const resume = [
    `Periode: ${date_debut} au ${date_fin}`,
    `Granularite: par ${granularite}`,
    `CA total: ${formatCurrency(totalCA)}`,
    `Commandes totales: ${formatNumber(totalCommandes)}`,
    `CA moyen par ${granularite}: ${formatCurrency(moyenneCA)}`,
  ].join("\n");

  return `# Evolution du Chiffre d'Affaires\n\n${resume}\n\n## Detail\n\n${tableau}`;
}

/**
 * Definitions des outils de rapport pour le serveur MCP
 *
 * Ces definitions sont utilisees par le serveur MCP pour exposer
 * les outils a Claude Desktop/Mobile.
 */
export const reportTools = {
  rapport_mensuel: {
    description:
      "Genere un rapport mensuel des commandes par operateur et par plan. " +
      "Montre le nombre de commandes et le montant total pour chaque combinaison operateur/plan.",
    inputSchema: {
      type: "object",
      properties: {
        mois: {
          type: "string",
          description: "Le mois au format YYYY-MM (ex: 2026-05)",
        },
      },
      required: ["mois"],
    },
    handler: rapportMensuel,
  },

  rapport_journalier: {
    description:
      "Genere un rapport journalier des commandes par operateur et par plan. " +
      "Peut etre filtre par plage horaire (ex: 9h-18h).",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "La date au format YYYY-MM-DD",
        },
        heure_debut: {
          type: "string",
          description: "Heure de debut au format HH:MM (optionnel)",
        },
        heure_fin: {
          type: "string",
          description: "Heure de fin au format HH:MM (optionnel)",
        },
      },
      required: ["date"],
    },
    handler: rapportJournalier,
  },

  rapport_periode: {
    description:
      "Genere un rapport pour une periode entre deux dates. " +
      "Agrege les donnees jour par jour.",
    inputSchema: {
      type: "object",
      properties: {
        date_debut: {
          type: "string",
          description: "Date de debut au format YYYY-MM-DD",
        },
        date_fin: {
          type: "string",
          description: "Date de fin au format YYYY-MM-DD",
        },
      },
      required: ["date_debut", "date_fin"],
    },
    handler: rapportPeriode,
  },

  stats_operateurs: {
    description:
      "Affiche les statistiques de repartition par operateur " +
      "(nombre de commandes, montant, pourcentage).",
    inputSchema: {
      type: "object",
      properties: {
        periode: {
          type: "string",
          enum: ["jour", "semaine", "mois", "annee"],
          description: "La periode d'analyse",
        },
      },
      required: ["periode"],
    },
    handler: statsOperateurs,
  },

  top_plans: {
    description:
      "Affiche le classement des plans les plus vendus " +
      "avec le nombre de ventes et le chiffre d'affaires.",
    inputSchema: {
      type: "object",
      properties: {
        limite: {
          type: "number",
          description: "Nombre de plans a afficher (defaut: 10, max: 50)",
        },
        periode: {
          type: "string",
          enum: ["jour", "semaine", "mois", "annee"],
          description: "La periode d'analyse (defaut: mois)",
        },
      },
      required: [],
    },
    handler: topPlans,
  },

  evolution_ca: {
    description:
      "Affiche l'evolution du chiffre d'affaires sur une periode " +
      "avec une granularite ajustable (jour, semaine, mois).",
    inputSchema: {
      type: "object",
      properties: {
        date_debut: {
          type: "string",
          description: "Date de debut au format YYYY-MM-DD",
        },
        date_fin: {
          type: "string",
          description: "Date de fin au format YYYY-MM-DD",
        },
        granularite: {
          type: "string",
          enum: ["jour", "semaine", "mois"],
          description: "Granularite de l'analyse (defaut: jour)",
        },
      },
      required: ["date_debut", "date_fin"],
    },
    handler: evolutionCa,
  },
};
