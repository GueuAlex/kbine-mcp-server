/**
 * Module de formatage des resultats pour l'affichage
 *
 * Ce module contient des fonctions utilitaires pour formater les donnees
 * retournees par les requetes SQL en formats lisibles pour l'utilisateur.
 *
 * Les formats supportes:
 * - Tableaux Markdown pour les rapports
 * - Listes formatees pour les diagnostics
 * - Nombres avec separateurs de milliers
 * - Dates en format francais
 */

import { RowDataPacket } from "mysql2/promise";

/**
 * Formate un nombre avec separateurs de milliers
 *
 * Utilise l'espace comme separateur (format francais)
 * et la virgule comme separateur decimal.
 *
 * @param value - Le nombre a formater
 * @param decimals - Nombre de decimales (par defaut: 0)
 * @returns Le nombre formate en string
 *
 * @example
 * formatNumber(1234567) // "1 234 567"
 * formatNumber(1234.567, 2) // "1 234,57"
 */
export function formatNumber(value: number, decimals: number = 0): string {
  // Arrondir au nombre de decimales demande
  const rounded = Number(value.toFixed(decimals));

  // Formater avec separateurs francais
  return rounded.toLocaleString("fr-FR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Formate un montant en FCFA
 *
 * Ajoute le symbole FCFA et formate le nombre avec separateurs.
 *
 * @param amount - Le montant a formater
 * @returns Le montant formate avec le symbole FCFA
 *
 * @example
 * formatCurrency(50000) // "50 000 FCFA"
 */
export function formatCurrency(amount: number): string {
  return `${formatNumber(amount, 0)} FCFA`;
}

/**
 * Formate une date en format francais lisible
 *
 * @param date - La date a formater (Date, string, ou null)
 * @param includeTime - Inclure l'heure (par defaut: false)
 * @returns La date formatee ou "N/A" si null
 *
 * @example
 * formatDate(new Date("2026-05-28")) // "28/05/2026"
 * formatDate(new Date("2026-05-28T14:30:00"), true) // "28/05/2026 14:30"
 */
export function formatDate(
  date: Date | string | null,
  includeTime: boolean = false
): string {
  if (!date) {
    return "N/A";
  }

  const d = typeof date === "string" ? new Date(date) : date;

  // Verifier que la date est valide
  if (isNaN(d.getTime())) {
    return "Date invalide";
  }

  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  };

  if (includeTime) {
    options.hour = "2-digit";
    options.minute = "2-digit";
  }

  return d.toLocaleDateString("fr-FR", options);
}

/**
 * Formate une duree en minutes en format lisible
 *
 * Convertit les minutes en heures/minutes si necessaire.
 *
 * @param minutes - Nombre de minutes
 * @returns La duree formatee
 *
 * @example
 * formatDuration(45) // "45 min"
 * formatDuration(90) // "1h 30min"
 * formatDuration(180) // "3h"
 */
export function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}min`;
}

/**
 * Convertit un tableau de resultats SQL en tableau Markdown
 *
 * Cette fonction prend les resultats d'une requete SQL et les formate
 * en tableau Markdown pour un affichage clair dans Claude.
 *
 * @param rows - Les lignes de resultats de la requete SQL
 * @param columnFormatters - Formateurs optionnels par nom de colonne
 * @returns Le tableau formate en Markdown
 *
 * @example
 * const rows = [
 *   { operateur: "Orange", total: 50000 },
 *   { operateur: "MTN", total: 30000 }
 * ];
 * const markdown = toMarkdownTable(rows, {
 *   total: (v) => formatCurrency(v)
 * });
 */
export function toMarkdownTable(
  rows: RowDataPacket[],
  columnFormatters: Record<string, (value: unknown) => string> = {}
): string {
  // Si aucun resultat, retourner un message
  if (!rows || rows.length === 0) {
    return "Aucun resultat trouve.";
  }

  // Extraire les noms de colonnes de la premiere ligne
  const columns = Object.keys(rows[0] as object);

  // Creer l'en-tete du tableau
  const header = `| ${columns.join(" | ")} |`;

  // Creer la ligne de separation (alignement a gauche par defaut)
  const separator = `| ${columns.map(() => "---").join(" | ")} |`;

  // Creer les lignes de donnees
  const dataRows = rows.map((row) => {
    const values = columns.map((col) => {
      const value = (row as Record<string, unknown>)[col];

      // Appliquer le formateur si defini pour cette colonne
      if (columnFormatters[col]) {
        return columnFormatters[col](value);
      }

      // Formatage par defaut selon le type
      if (value === null || value === undefined) {
        return "N/A";
      }

      if (value instanceof Date) {
        return formatDate(value);
      }

      if (typeof value === "number") {
        // Detecter si c'est probablement un montant (grand nombre)
        if (value > 1000 && Number.isInteger(value)) {
          return formatNumber(value);
        }
        return value.toString();
      }

      return String(value);
    });

    return `| ${values.join(" | ")} |`;
  });

  // Assembler le tableau complet
  return [header, separator, ...dataRows].join("\n");
}

/**
 * Formate un resultat de diagnostic de paiement en texte lisible
 *
 * Cette fonction prend les informations d'un paiement et les formate
 * en un bloc de texte structure pour le diagnostic.
 *
 * @param payment - Les informations du paiement
 * @returns Le texte formate pour l'affichage
 */
export function formatPaymentDiagnostic(payment: RowDataPacket): string {
  const lines = [
    "--- Paiement ---",
    `Reference: ${payment.payment_reference || "N/A"}`,
    `Reference TouchPoint: ${payment.touchpoint_reference || "N/A"}`,
    `Montant: ${formatCurrency(payment.payment_amount || payment.amount || 0)}`,
    `Statut: ${payment.payment_status || payment.status || "N/A"}`,
    `Methode: ${payment.payment_method || "N/A"}`,
    `Telephone: ${payment.payment_phone || "N/A"}`,
    "",
    "--- Commande ---",
    `Reference: ${payment.order_reference || "N/A"}`,
    `Montant: ${formatCurrency(payment.order_amount || 0)}`,
    `Statut: ${payment.order_status || "N/A"}`,
    "",
    "--- Client ---",
    `Nom: ${payment.client_name || "N/A"}`,
    `Telephone: ${payment.client_phone || "N/A"}`,
    "",
    "--- Plan ---",
    `Plan: ${payment.plan_name || "Transfert direct"}`,
    `Operateur: ${payment.operator_name || "N/A"}`,
    "",
    "--- Temps ---",
    `Cree le: ${formatDate(payment.payment_created_at, true)}`,
    `En attente depuis: ${formatDuration(payment.waiting_minutes || 0)}`,
  ];

  return lines.join("\n");
}

/**
 * Formate un resume statistique
 *
 * @param stats - Objet contenant les statistiques
 * @returns Le resume formate
 */
export function formatStatsSummary(stats: {
  totalCommandes: number;
  montantTotal: number;
  periode: string;
}): string {
  return [
    `Periode: ${stats.periode}`,
    `Nombre de commandes: ${formatNumber(stats.totalCommandes)}`,
    `Montant total: ${formatCurrency(stats.montantTotal)}`,
  ].join("\n");
}
