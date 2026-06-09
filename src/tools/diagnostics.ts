/**
 * Outils MCP pour le diagnostic des paiements
 *
 * Ce module contient les outils de diagnostic accessibles via le protocole MCP.
 * Ces outils permettent a M. Emmanuel de diagnostiquer les problemes de paiement
 * de maniere autonome, sans avoir a contacter le support technique.
 *
 * OUTILS DISPONIBLES:
 * - paiements_pending: Liste des paiements en attente depuis trop longtemps
 * - paiement_client: Historique des paiements d'un client specifique
 * - statut_commande: Detail complet d'une commande par sa reference
 *
 * CAS D'USAGE:
 * - Un client signale que son paiement "tourne en rond"
 * - Verification du statut d'une transaction
 * - Escalade vers TouchPoint avec les bonnes informations
 *
 * SECURITE:
 * - Toutes les requetes sont en lecture seule
 * - Les donnees sensibles (passwords, tokens) ne sont pas exposees
 * - Les numeros de telephone des clients sont visibles pour le diagnostic
 */

import { z } from "zod";
import { RowDataPacket } from "mysql2/promise";
import { executeQuery } from "../database/connection.js";
import {
  toMarkdownTable,
  formatCurrency,
  formatDuration,
  formatDate,
} from "../utils/formatters.js";

/**
 * Schema de validation pour la liste des paiements pending
 */
const paiementsPendingSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La date doit etre au format YYYY-MM-DD"),
  minutes_attente: z.number().int().min(1).max(1440).optional().default(15),
});

/**
 * Liste les paiements en statut "pending" depuis trop longtemps
 *
 * Un paiement est considere comme "bloque" s'il reste en statut pending
 * au-dela d'un certain delai (par defaut 15 minutes). Cela peut indiquer:
 * - Un probleme cote passerelle de paiement (TouchPoint)
 * - Un callback non recu
 * - Une erreur cote operateur mobile money
 *
 * Les informations retournees permettent:
 * - D'identifier le client concerne
 * - De voir la reference TouchPoint pour l'escalade
 * - De mesurer le temps d'attente
 *
 * @param args - Arguments contenant la date et le seuil en minutes
 * @returns Liste des paiements pending avec details
 */
export async function paiementsPending(args: unknown): Promise<string> {
  const { date, minutes_attente } = paiementsPendingSchema.parse(args);

  // Requete basee sur la procedure stockee paiements_clients
  // Voir maintenan-KBINE.md pour la documentation originale
  const sql = `
    SELECT
      u.phone_number AS client_phone,
      u.full_name AS client_name,
      o.order_reference,
      o.amount AS order_amount,
      o.status AS order_status,
      COALESCE(p.name, 'Transfert direct') AS plan_name,
      COALESCE(op.name, 'N/A') AS operator_name,
      pay.payment_reference,
      pay.external_reference AS touchpoint_reference,
      pay.payment_method,
      pay.amount AS payment_amount,
      pay.status AS payment_status,
      pay.created_at AS payment_created_at,
      TIMESTAMPDIFF(MINUTE, pay.created_at, NOW()) AS waiting_minutes

    FROM payments pay
    INNER JOIN orders o ON pay.order_id = o.id
    INNER JOIN users u ON o.user_id = u.id
    LEFT JOIN plans p ON o.plan_id = p.id
    LEFT JOIN operators op ON p.operator_id = op.id

    WHERE pay.status = 'pending'
      AND DATE(pay.created_at) = ?
      AND TIMESTAMPDIFF(MINUTE, pay.created_at, NOW()) > ?

    ORDER BY pay.created_at DESC
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, [date, minutes_attente]);

  // Message si aucun paiement bloque
  if (rows.length === 0) {
    return (
      `Bonne nouvelle! Aucun paiement en attente depuis plus de ${minutes_attente} minutes ` +
      `pour la date du ${date}.\n\n` +
      `Cela signifie que tous les paiements ont ete traites normalement.`
    );
  }

  // Formatage du tableau de resultats
  const tableau = toMarkdownTable(rows, {
    order_amount: (v) => formatCurrency(Number(v)),
    payment_amount: (v) => formatCurrency(Number(v)),
    waiting_minutes: (v) => formatDuration(Number(v)),
    payment_created_at: (v) => formatDate(v as Date, true),
  });

  // Resume avec le nombre de paiements bloques
  const totalMontant = rows.reduce(
    (sum, row) => sum + (Number(row.payment_amount) || 0),
    0
  );

  const resume = [
    `Date analysee: ${date}`,
    `Seuil d'attente: ${minutes_attente} minutes`,
    `Paiements bloques: ${rows.length}`,
    `Montant total bloque: ${formatCurrency(totalMontant)}`,
    "",
    "ACTIONS RECOMMANDEES:",
    "1. Verifier le statut sur le dashboard TouchPoint",
    "2. Contacter le support TouchPoint avec les references touchpoint_reference",
    "3. Informer les clients concernes si necessaire",
  ].join("\n");

  return `# Paiements en Attente - ${date}\n\n${resume}\n\n## Liste des paiements\n\n${tableau}`;
}

/**
 * Schema de validation pour les paiements d'un client
 */
const paiementClientSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La date doit etre au format YYYY-MM-DD"),
  telephone: z
    .string()
    .regex(/^0[0-9]{9}$/, "Le telephone doit etre au format 0XXXXXXXXX (10 chiffres)"),
});

/**
 * Affiche les paiements d'un client specifique pour une date donnee
 *
 * Utile quand M. Emmanuel recoit une reclamation d'un client specifique.
 * Permet de voir:
 * - Tous les paiements du client ce jour-la
 * - Le statut de chaque paiement
 * - Les details pour investigation
 *
 * @param args - Arguments contenant la date et le numero de telephone
 * @returns Historique des paiements du client
 */
export async function paiementClient(args: unknown): Promise<string> {
  const { date, telephone } = paiementClientSchema.parse(args);

  const sql = `
    SELECT
      u.full_name AS client_name,
      o.order_reference,
      o.phone_number AS numero_recharge,
      o.amount AS order_amount,
      o.status AS order_status,
      COALESCE(p.name, 'Transfert direct') AS plan_name,
      COALESCE(op.name, 'N/A') AS operator_name,
      pay.payment_reference,
      pay.external_reference AS touchpoint_reference,
      pay.payment_method,
      pay.amount AS payment_amount,
      pay.status AS payment_status,
      pay.created_at AS payment_created_at,
      CASE
        WHEN pay.status = 'pending' THEN TIMESTAMPDIFF(MINUTE, pay.created_at, NOW())
        ELSE NULL
      END AS waiting_minutes

    FROM payments pay
    INNER JOIN orders o ON pay.order_id = o.id
    INNER JOIN users u ON o.user_id = u.id
    LEFT JOIN plans p ON o.plan_id = p.id
    LEFT JOIN operators op ON p.operator_id = op.id

    WHERE DATE(pay.created_at) = ?
      AND u.phone_number = ?

    ORDER BY pay.created_at DESC
  `;

  const rows = await executeQuery<RowDataPacket[]>(sql, [date, telephone]);

  if (rows.length === 0) {
    return (
      `Aucun paiement trouve pour le client ${telephone} le ${date}.\n\n` +
      `Verifiez que:\n` +
      `- Le numero de telephone est correct (format: 0XXXXXXXXX)\n` +
      `- La date est correcte\n` +
      `- Le client a bien effectue un paiement ce jour-la`
    );
  }

  // Nom du client (le meme pour toutes les lignes)
  const clientName = rows[0]?.client_name || "Client inconnu";

  // Compter les paiements par statut
  const stats = {
    total: rows.length,
    success: rows.filter((r) => r.payment_status === "success").length,
    pending: rows.filter((r) => r.payment_status === "pending").length,
    failed: rows.filter((r) => r.payment_status === "failed").length,
  };

  const tableau = toMarkdownTable(rows, {
    order_amount: (v) => formatCurrency(Number(v)),
    payment_amount: (v) => formatCurrency(Number(v)),
    waiting_minutes: (v) => (v ? formatDuration(Number(v)) : "-"),
    payment_created_at: (v) => formatDate(v as Date, true),
  });

  const resume = [
    `Client: ${clientName}`,
    `Telephone: ${telephone}`,
    `Date: ${date}`,
    "",
    `Total paiements: ${stats.total}`,
    `- Reussis: ${stats.success}`,
    `- En attente: ${stats.pending}`,
    `- Echoues: ${stats.failed}`,
  ].join("\n");

  return `# Paiements du Client ${telephone}\n\n${resume}\n\n## Historique\n\n${tableau}`;
}

/**
 * Schema de validation pour le statut d'une commande
 */
const statutCommandeSchema = z.object({
  reference: z
    .string()
    .regex(
      /^ORD-\d{8}-[A-Z0-9]{5}$/,
      "La reference doit etre au format ORD-YYYYMMDD-XXXXX"
    ),
});

/**
 * Affiche le detail complet d'une commande par sa reference
 *
 * Utile pour:
 * - Verifier l'etat d'une commande specifique
 * - Voir tous les paiements associes (en cas de tentatives multiples)
 * - Obtenir les informations pour l'escalade
 *
 * La reference de commande a le format: ORD-YYYYMMDD-XXXXX
 * Exemple: ORD-20260528-A1B2C
 *
 * @param args - Arguments contenant la reference de commande
 * @returns Detail complet de la commande et ses paiements
 */
export async function statutCommande(args: unknown): Promise<string> {
  const { reference } = statutCommandeSchema.parse(args);

  // Recuperer les informations de la commande
  const orderSql = `
    SELECT
      o.id AS order_id,
      o.order_reference,
      o.phone_number AS numero_recharge,
      o.amount AS order_amount,
      o.status AS order_status,
      o.created_at AS order_created_at,
      o.updated_at AS order_updated_at,
      u.full_name AS client_name,
      u.phone_number AS client_phone,
      COALESCE(p.name, 'Transfert direct') AS plan_name,
      COALESCE(p.type, 'direct') AS plan_type,
      COALESCE(op.name, 'N/A') AS operator_name

    FROM orders o
    INNER JOIN users u ON o.user_id = u.id
    LEFT JOIN plans p ON o.plan_id = p.id
    LEFT JOIN operators op ON p.operator_id = op.id

    WHERE o.order_reference = ?
  `;

  const orders = await executeQuery<RowDataPacket[]>(orderSql, [reference]);

  if (orders.length === 0) {
    return (
      `Commande introuvable: ${reference}\n\n` +
      `Verifiez que:\n` +
      `- La reference est correcte (format: ORD-YYYYMMDD-XXXXX)\n` +
      `- La commande existe dans le systeme`
    );
  }

  const order = orders[0];

  // Recuperer tous les paiements associes a cette commande
  // (il peut y avoir plusieurs tentatives de paiement)
  const paymentsSql = `
    SELECT
      pay.payment_reference,
      pay.external_reference AS touchpoint_reference,
      pay.payment_method,
      pay.payment_phone,
      pay.amount AS payment_amount,
      pay.status AS payment_status,
      pay.created_at AS payment_created_at,
      pay.updated_at AS payment_updated_at,
      CASE
        WHEN pay.status = 'pending' THEN TIMESTAMPDIFF(MINUTE, pay.created_at, NOW())
        ELSE NULL
      END AS waiting_minutes

    FROM payments pay
    WHERE pay.order_id = ?
    ORDER BY pay.created_at DESC
  `;

  const payments = await executeQuery<RowDataPacket[]>(paymentsSql, [
    order?.order_id,
  ]);

  // Construire le rapport detaille
  const orderDetails = [
    "## Commande",
    "",
    `| Champ | Valeur |`,
    `| --- | --- |`,
    `| Reference | ${order?.order_reference} |`,
    `| Statut | ${order?.order_status} |`,
    `| Montant | ${formatCurrency(Number(order?.order_amount))} |`,
    `| Numero a recharger | ${order?.numero_recharge} |`,
    `| Plan | ${order?.plan_name} |`,
    `| Operateur | ${order?.operator_name} |`,
    `| Cree le | ${formatDate(order?.order_created_at as Date, true)} |`,
    `| Mis a jour le | ${formatDate(order?.order_updated_at as Date, true)} |`,
  ].join("\n");

  const clientDetails = [
    "## Client",
    "",
    `| Champ | Valeur |`,
    `| --- | --- |`,
    `| Nom | ${order?.client_name} |`,
    `| Telephone | ${order?.client_phone} |`,
  ].join("\n");

  let paymentsDetails: string;
  if (payments.length === 0) {
    paymentsDetails = "## Paiements\n\nAucun paiement enregistre pour cette commande.";
  } else {
    const paymentsTable = toMarkdownTable(payments, {
      payment_amount: (v) => formatCurrency(Number(v)),
      payment_created_at: (v) => formatDate(v as Date, true),
      payment_updated_at: (v) => formatDate(v as Date, true),
      waiting_minutes: (v) => (v ? formatDuration(Number(v)) : "-"),
    });
    paymentsDetails = `## Paiements (${payments.length} tentative(s))\n\n${paymentsTable}`;
  }

  // Diagnostic automatique
  const diagnostic = generateDiagnostic(order as RowDataPacket, payments);

  return [
    `# Statut Commande ${reference}`,
    "",
    orderDetails,
    "",
    clientDetails,
    "",
    paymentsDetails,
    "",
    diagnostic,
  ].join("\n");
}

/**
 * Genere un diagnostic automatique base sur l'etat de la commande
 *
 * Analyse la commande et ses paiements pour suggerer des actions.
 *
 * @param order - Les informations de la commande
 * @param payments - Les paiements associes
 * @returns Le diagnostic formate
 */
function generateDiagnostic(
  order: RowDataPacket,
  payments: RowDataPacket[]
): string {
  const lines = ["## Diagnostic"];

  // Cas 1: Commande sans paiement
  if (payments.length === 0) {
    lines.push("");
    lines.push("PROBLEME: Aucun paiement initie pour cette commande.");
    lines.push("");
    lines.push("Causes possibles:");
    lines.push("- Le client n'a pas finalise le paiement");
    lines.push("- Erreur lors de l'initialisation du paiement");
    lines.push("");
    lines.push("Action: Demander au client de reessayer le paiement.");
    return lines.join("\n");
  }

  // Verifier s'il y a un paiement reussi
  const successPayment = payments.find((p) => p.payment_status === "success");
  const pendingPayments = payments.filter((p) => p.payment_status === "pending");
  const failedPayments = payments.filter((p) => p.payment_status === "failed");

  // Cas 2: Paiement reussi
  if (successPayment) {
    lines.push("");
    lines.push("STATUT: Paiement reussi");
    lines.push("");
    lines.push(`Reference paiement: ${successPayment.payment_reference}`);
    lines.push(`Reference TouchPoint: ${successPayment.touchpoint_reference || "N/A"}`);
    lines.push("");

    if (order.order_status === "success") {
      lines.push("La commande a ete traitee avec succes. Tout est en ordre.");
    } else {
      lines.push("ATTENTION: Le paiement est reussi mais la commande n'est pas en statut 'success'.");
      lines.push("Action: Verifier si la recharge a ete effectuee cote operateur.");
    }
    return lines.join("\n");
  }

  // Cas 3: Paiements en attente
  if (pendingPayments.length > 0) {
    const longestWait = Math.max(
      ...pendingPayments.map((p) => Number(p.waiting_minutes) || 0)
    );

    lines.push("");
    lines.push(`STATUT: ${pendingPayments.length} paiement(s) en attente`);
    lines.push(`Temps d'attente max: ${formatDuration(longestWait)}`);
    lines.push("");

    if (longestWait > 30) {
      lines.push("PROBLEME: Le paiement attend depuis plus de 30 minutes.");
      lines.push("");
      lines.push("Actions recommandees:");
      lines.push("1. Verifier le statut sur le dashboard TouchPoint");
      lines.push("2. Contacter le support TouchPoint avec ces informations:");

      for (const payment of pendingPayments) {
        lines.push(`   - Reference: ${payment.touchpoint_reference || payment.payment_reference}`);
      }

      lines.push("");
      lines.push("Groupe Teams TouchPoint: https://teams.live.com/l/invite/FEA7DoOrNDTnX45Ph8");
    } else {
      lines.push("Le paiement est en cours de traitement. Attendre quelques minutes.");
    }
    return lines.join("\n");
  }

  // Cas 4: Tous les paiements ont echoue
  if (failedPayments.length > 0 && pendingPayments.length === 0 && !successPayment) {
    lines.push("");
    lines.push(`STATUT: ${failedPayments.length} paiement(s) echoue(s)`);
    lines.push("");
    lines.push("Le client doit retenter le paiement.");
    lines.push("");
    lines.push("Si le probleme persiste, verifier:");
    lines.push("- Le solde du compte mobile money du client");
    lines.push("- La validite du numero de paiement");
    lines.push("- Le statut de l'operateur de paiement");
    return lines.join("\n");
  }

  // Cas par defaut
  lines.push("");
  lines.push("Situation non standard. Contacter le support technique.");
  return lines.join("\n");
}

/**
 * Definitions des outils de diagnostic pour le serveur MCP
 */
export const diagnosticTools = {
  paiements_pending: {
    description:
      "Liste les paiements en statut 'pending' depuis plus de X minutes. " +
      "Utile pour identifier les paiements bloques qui necessitent une intervention.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "La date a analyser au format YYYY-MM-DD",
        },
        minutes_attente: {
          type: "number",
          description: "Seuil en minutes (defaut: 15). Paiements attendant plus longtemps seront listes.",
        },
      },
      required: ["date"],
    },
    handler: paiementsPending,
  },

  paiement_client: {
    description:
      "Affiche l'historique des paiements d'un client specifique pour une date donnee. " +
      "Utile pour diagnostiquer les problemes signales par un client.",
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "La date a analyser au format YYYY-MM-DD",
        },
        telephone: {
          type: "string",
          description: "Numero de telephone du client au format 0XXXXXXXXX",
        },
      },
      required: ["date", "telephone"],
    },
    handler: paiementClient,
  },

  statut_commande: {
    description:
      "Affiche le detail complet d'une commande par sa reference, " +
      "incluant tous les paiements associes et un diagnostic automatique.",
    inputSchema: {
      type: "object",
      properties: {
        reference: {
          type: "string",
          description: "Reference de commande au format ORD-YYYYMMDD-XXXXX",
        },
      },
      required: ["reference"],
    },
    handler: statutCommande,
  },
};
