-- =============================================================================
-- Script d'initialisation de la base de donnees de developpement
-- =============================================================================
--
-- Ce script cree les tables et donnees de test pour le developpement local.
-- Il est execute automatiquement au premier demarrage du container MySQL.
--
-- TABLES CREEES:
--   - operators: Operateurs telecom (Orange, MTN, Moov)
--   - plans: Plans/forfaits par operateur
--   - users: Utilisateurs de l'application
--   - orders: Commandes de recharge
--   - payments: Paiements associes aux commandes
--
-- DONNEES DE TEST:
--   - 3 operateurs avec leurs prefixes
--   - 10 plans varies
--   - 5 utilisateurs de test
--   - 50 commandes sur les 30 derniers jours
--   - Paiements avec differents statuts
--
-- =============================================================================

USE kbine_db;

-- -----------------------------------------------------------------------------
-- Table: operators
-- Liste des operateurs telecom disponibles
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operators (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    code VARCHAR(20) NOT NULL UNIQUE,
    prefixes JSON NOT NULL COMMENT 'Prefixes telephoniques JSON array',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Table: plans
-- Plans/forfaits proposes par chaque operateur
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    operator_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10, 2) NOT NULL,
    type VARCHAR(50) NOT NULL COMMENT 'Type: data, voice, mixed',
    validity_days INT DEFAULT 30,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (operator_id) REFERENCES operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Table: users
-- Utilisateurs de l'application mobile
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    phone_number VARCHAR(20) NOT NULL UNIQUE,
    email VARCHAR(100),
    password_hash VARCHAR(255) NOT NULL COMMENT 'Hash du mot de passe - NE PAS EXPOSER',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Table: orders
-- Commandes de recharge/forfait
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_reference VARCHAR(50) NOT NULL UNIQUE COMMENT 'Format: ORD-YYYYMMDD-XXXXX',
    user_id INT NOT NULL,
    plan_id INT COMMENT 'NULL pour transfert direct',
    phone_number VARCHAR(20) NOT NULL COMMENT 'Numero a recharger',
    amount DECIMAL(10, 2) NOT NULL,
    status ENUM('pending', 'processing', 'success', 'failed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (plan_id) REFERENCES plans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Table: payments
-- Paiements associes aux commandes
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id INT NOT NULL,
    payment_reference VARCHAR(50) NOT NULL UNIQUE,
    external_reference VARCHAR(100) COMMENT 'Reference TouchPoint',
    payment_method ENUM('wave', 'mtn', 'orange', 'moov') NOT NULL,
    payment_phone VARCHAR(20) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status ENUM('pending', 'success', 'failed') DEFAULT 'pending',
    callback_data JSON COMMENT 'Donnees brutes du callback',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- Vue: v_users_safe
-- Vue securisee des utilisateurs (sans donnees sensibles)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_users_safe AS
SELECT
    id,
    full_name,
    phone_number,
    created_at
FROM users;

-- =============================================================================
-- DONNEES DE TEST
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Operateurs
-- -----------------------------------------------------------------------------
INSERT INTO operators (name, code, prefixes) VALUES
('Orange', 'ORANGE_CI', '["07", "08", "09"]'),
('MTN', 'MTN_CI', '["05", "04"]'),
('Moov', 'MOOV_CI', '["01", "02"]');

-- -----------------------------------------------------------------------------
-- Plans
-- -----------------------------------------------------------------------------
INSERT INTO plans (operator_id, name, description, price, type, validity_days) VALUES
-- Orange
(1, 'Orange Internet 1Go', 'Forfait internet 1Go valable 7 jours', 500, 'data', 7),
(1, 'Orange Internet 5Go', 'Forfait internet 5Go valable 30 jours', 2000, 'data', 30),
(1, 'Orange Appels Illimites', 'Appels illimites Orange 24h', 1000, 'voice', 1),
(1, 'Orange Mix 2Go + 60min', 'Forfait mixte 2Go + 60min tous reseaux', 1500, 'mixed', 15),
-- MTN
(2, 'MTN Y ello Data 2Go', 'Forfait data 2Go valable 7 jours', 1000, 'data', 7),
(2, 'MTN Y ello Data 10Go', 'Forfait data 10Go valable 30 jours', 5000, 'data', 30),
(2, 'MTN Zone Appels', 'Forfait appels 100min tous reseaux', 2000, 'voice', 30),
-- Moov
(3, 'Moov Internet 500Mo', 'Forfait internet 500Mo valable 3 jours', 300, 'data', 3),
(3, 'Moov Internet 3Go', 'Forfait internet 3Go valable 30 jours', 1500, 'data', 30),
(3, 'Moov Illimix', 'Forfait mixte illimite 24h', 500, 'mixed', 1);

-- -----------------------------------------------------------------------------
-- Utilisateurs de test
-- -----------------------------------------------------------------------------
INSERT INTO users (full_name, phone_number, email, password_hash) VALUES
('Kouame Jean', '0707123456', 'kouame.jean@test.ci', 'hash_not_exposed'),
('Traore Aminata', '0505987654', 'traore.aminata@test.ci', 'hash_not_exposed'),
('Koffi Emmanuel', '0108456789', 'koffi.emmanuel@test.ci', 'hash_not_exposed'),
('Diallo Fatou', '0709112233', 'diallo.fatou@test.ci', 'hash_not_exposed'),
('Bamba Sekou', '0504445566', 'bamba.sekou@test.ci', 'hash_not_exposed');

-- -----------------------------------------------------------------------------
-- Commandes et paiements de test
-- Genere des commandes sur les 30 derniers jours
-- -----------------------------------------------------------------------------

-- Fonction pour generer une reference de commande
DELIMITER $$
CREATE FUNCTION IF NOT EXISTS generate_order_ref(order_date DATE, seq INT)
RETURNS VARCHAR(50) DETERMINISTIC
BEGIN
    RETURN CONCAT('ORD-', DATE_FORMAT(order_date, '%Y%m%d'), '-', LPAD(seq, 5, 'A'));
END$$
DELIMITER ;

-- Procedure pour generer des commandes de test
DELIMITER $$
CREATE PROCEDURE IF NOT EXISTS generate_test_orders()
BEGIN
    DECLARE i INT DEFAULT 0;
    DECLARE order_date DATE;
    DECLARE user_id INT;
    DECLARE plan_id INT;
    DECLARE phone_num VARCHAR(20);
    DECLARE amount DECIMAL(10,2);
    DECLARE order_status VARCHAR(20);
    DECLARE payment_status VARCHAR(20);
    DECLARE payment_method VARCHAR(20);
    DECLARE order_ref VARCHAR(50);
    DECLARE payment_ref VARCHAR(50);
    DECLARE order_id INT;

    WHILE i < 50 DO
        -- Date aleatoire sur les 30 derniers jours
        SET order_date = DATE_SUB(CURDATE(), INTERVAL FLOOR(RAND() * 30) DAY);

        -- Utilisateur aleatoire
        SET user_id = FLOOR(1 + RAND() * 5);

        -- Plan aleatoire (avec 20% de transferts directs)
        IF RAND() < 0.2 THEN
            SET plan_id = NULL;
            SET amount = FLOOR(500 + RAND() * 9500);
        ELSE
            SET plan_id = FLOOR(1 + RAND() * 10);
            SELECT price INTO amount FROM plans WHERE id = plan_id;
        END IF;

        -- Numero a recharger
        SET phone_num = CONCAT('07', LPAD(FLOOR(RAND() * 100000000), 8, '0'));

        -- Statut aleatoire (70% success, 20% pending, 10% failed)
        SET @rand_status = RAND();
        IF @rand_status < 0.7 THEN
            SET order_status = 'success';
            SET payment_status = 'success';
        ELSEIF @rand_status < 0.9 THEN
            SET order_status = 'pending';
            SET payment_status = 'pending';
        ELSE
            SET order_status = 'failed';
            SET payment_status = 'failed';
        END IF;

        -- Methode de paiement aleatoire
        SET @rand_method = RAND();
        IF @rand_method < 0.4 THEN
            SET payment_method = 'wave';
        ELSEIF @rand_method < 0.7 THEN
            SET payment_method = 'mtn';
        ELSEIF @rand_method < 0.9 THEN
            SET payment_method = 'orange';
        ELSE
            SET payment_method = 'moov';
        END IF;

        -- References
        SET order_ref = CONCAT('ORD-', DATE_FORMAT(order_date, '%Y%m%d'), '-', UPPER(SUBSTRING(MD5(RAND()), 1, 5)));
        SET payment_ref = CONCAT('PAY-', UPPER(SUBSTRING(MD5(RAND()), 1, 10)));

        -- Inserer la commande
        INSERT INTO orders (order_reference, user_id, plan_id, phone_number, amount, status, created_at)
        VALUES (order_ref, user_id, plan_id, phone_num, amount, order_status,
                TIMESTAMP(order_date, SEC_TO_TIME(FLOOR(RAND() * 86400))));

        SET order_id = LAST_INSERT_ID();

        -- Inserer le paiement
        INSERT INTO payments (order_id, payment_reference, external_reference, payment_method,
                            payment_phone, amount, status, created_at)
        VALUES (order_id, payment_ref, CONCAT('TP-', UPPER(SUBSTRING(MD5(RAND()), 1, 15))),
                payment_method, phone_num, amount, payment_status,
                (SELECT created_at FROM orders WHERE id = order_id));

        SET i = i + 1;
    END WHILE;
END$$
DELIMITER ;

-- Executer la procedure
CALL generate_test_orders();

-- Nettoyer
DROP PROCEDURE IF EXISTS generate_test_orders;
DROP FUNCTION IF EXISTS generate_order_ref;

-- -----------------------------------------------------------------------------
-- Index pour les performances
-- -----------------------------------------------------------------------------
CREATE INDEX idx_orders_created_at ON orders(created_at);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_payments_created_at ON payments(created_at);

-- =============================================================================
-- Fin du script d'initialisation
-- =============================================================================
