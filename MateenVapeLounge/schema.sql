-- =====================================================================
-- Mateen VapeLounge - Inventory Management System
-- Database Schema (MySQL 8+)
-- Category -> Brand -> Product hierarchy with refill services.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS mateen_vapelounge
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE mateen_vapelounge;

-- ---------------------------------------------------------------------
-- Drop dependent tables first (idempotent re-run support).
-- USERS and AUDIT_LOG are preserved across migrations.
-- ---------------------------------------------------------------------
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS refills;
DROP TABLE IF EXISTS sales;
DROP TABLE IF EXISTS purchases;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS brands;
DROP TABLE IF EXISTS refill_sizes;
DROP TABLE IF EXISTS categories;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------
-- USERS  (created only if absent — preserved across re-runs)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('owner','staff') NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_users_email (email),
    INDEX idx_users_role (role)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- AUDIT LOG (preserved)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
    id INT PRIMARY KEY AUTO_INCREMENT,
    user_id INT,
    user_name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL,
    action VARCHAR(100) NOT NULL,
    details TEXT,
    ip_address VARCHAR(45),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_timestamp (timestamp),
    INDEX idx_audit_user (user_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- CATEGORIES
-- ---------------------------------------------------------------------
CREATE TABLE categories (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_categories_name (name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- BRANDS  (belong to a category)
-- ---------------------------------------------------------------------
CREATE TABLE brands (
    id INT PRIMARY KEY AUTO_INCREMENT,
    category_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(255),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
    INDEX idx_brands_category (category_id),
    INDEX idx_brands_name (name)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PRODUCTS  (belong to a brand, optionally refillable with price/ml)
-- ---------------------------------------------------------------------
CREATE TABLE products (
    id INT PRIMARY KEY AUTO_INCREMENT,
    brand_id INT NOT NULL,
    name VARCHAR(150) NOT NULL,
    description VARCHAR(255),
    cost_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    selling_price DECIMAL(10,2) NOT NULL DEFAULT 0,
    price_per_ml DECIMAL(10,2) DEFAULT NULL,
    stock_quantity INT NOT NULL DEFAULT 0,
    low_stock_threshold INT NOT NULL DEFAULT 5,
    is_refillable BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
    INDEX idx_products_brand (brand_id),
    INDEX idx_products_active (is_active),
    INDEX idx_products_refillable (is_refillable)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- REFILL SIZES (master list — owner edits)
-- ---------------------------------------------------------------------
CREATE TABLE refill_sizes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    label VARCHAR(50) NOT NULL,
    ml_amount DECIMAL(5,2) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_refill_sizes_active (is_active)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- SALES  (product sales — DO reduce stock)
-- ---------------------------------------------------------------------
CREATE TABLE sales (
    id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT NOT NULL,
    staff_id INT NOT NULL,
    quantity_sold INT NOT NULL DEFAULT 1,
    selling_price_at_time DECIMAL(10,2) NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    sold_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (staff_id) REFERENCES users(id),
    INDEX idx_sales_sold_at (sold_at),
    INDEX idx_sales_staff (staff_id),
    INDEX idx_sales_product (product_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- REFILLS  (services — DO NOT reduce stock)
-- ---------------------------------------------------------------------
CREATE TABLE refills (
    id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT NOT NULL,
    staff_id INT NOT NULL,
    refill_size_id INT NOT NULL,
    ml_amount DECIMAL(5,2) NOT NULL,
    price_per_ml_at_time DECIMAL(10,2) NOT NULL,
    total_amount DECIMAL(10,2) NOT NULL,
    done_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (staff_id) REFERENCES users(id),
    FOREIGN KEY (refill_size_id) REFERENCES refill_sizes(id),
    INDEX idx_refills_done_at (done_at),
    INDEX idx_refills_staff (staff_id),
    INDEX idx_refills_product (product_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- PURCHASES (restocks)
-- ---------------------------------------------------------------------
CREATE TABLE purchases (
    id INT PRIMARY KEY AUTO_INCREMENT,
    product_id INT NOT NULL,
    owner_id INT NOT NULL,
    quantity_added INT NOT NULL,
    cost_price_at_time DECIMAL(10,2) NOT NULL,
    total_cost DECIMAL(10,2) NOT NULL,
    supplier_name VARCHAR(100),
    purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id),
    FOREIGN KEY (owner_id) REFERENCES users(id),
    INDEX idx_purchases_purchased_at (purchased_at),
    INDEX idx_purchases_product (product_id)
) ENGINE=InnoDB;

-- =====================================================================
-- SEED DATA
-- =====================================================================

INSERT INTO refill_sizes (label, ml_amount) VALUES
    ('1ml', 1.0),
    ('2ml', 2.0),
    ('3ml', 3.0),
    ('5ml', 5.0),
    ('Full Bottle', 30.0);

INSERT INTO categories (name) VALUES
    ('Pods'),
    ('Juice / Flavors'),
    ('Coils'),
    ('Devices'),
    ('Accessories');

INSERT INTO brands (category_id, name) VALUES
    (1, 'Elf Bar'),
    (1, 'Oxva'),
    (1, 'Lost Mary'),
    (2, 'Nasty Juice'),
    (2, 'Dr Vapes'),
    (3, 'Oxva Coils'),
    (3, 'Voopoo Coils'),
    (4, 'Voopoo'),
    (4, 'Oxva Devices');

INSERT INTO products
    (brand_id, name, cost_price, selling_price, price_per_ml,
     stock_quantity, low_stock_threshold, is_refillable)
VALUES
    (1, 'Elf Bar 600 Mango Ice',         800,  1200, NULL,    20, 5, FALSE),
    (1, 'Elf Bar 600 Blueberry',         800,  1200, NULL,    15, 5, FALSE),
    (2, 'Oxva Xlim Pod Mango',           700,  1100, NULL,    10, 3, FALSE),
    (4, 'Nasty Juice Mango 60ml',       1500,  2300, 100.00,   5, 2, TRUE),
    (4, 'Nasty Juice Strawberry 60ml',  1500,  2300, 100.00,   5, 2, TRUE),
    (5, 'Dr Vapes Pink 30ml',           1200,  2000, 130.00,   8, 2, TRUE),
    (6, 'Oxva Coil 0.6ohm',              500,   900, NULL,    20, 5, FALSE),
    (7, 'Voopoo PnP Coil 0.8ohm',        450,   800, NULL,    15, 5, FALSE),
    (8, 'Voopoo Drag S',                7000, 11000, NULL,     5, 2, FALSE),
    (9, 'Oxva Xlim Pro',                6000,  9500, NULL,     4, 2, FALSE);

-- The owner account is created automatically by app.py on first startup.
