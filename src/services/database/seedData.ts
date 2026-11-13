/**
 * University Database — the seeded sample dataset.
 * Schema uses real PRIMARY KEY / FOREIGN KEY constraints so the
 * explorer, joins and (later) visualizations can rely on them.
 */

export const UNIVERSITY_DB_NAME = 'University Database'

/** Table creation DDL. Executed once when no persisted snapshot exists. */
export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE departments (
  id              INTEGER PRIMARY KEY,
  department_name TEXT NOT NULL,
  location        TEXT NOT NULL
);

CREATE TABLE employees (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  department_id INTEGER REFERENCES departments (id),
  salary        INTEGER NOT NULL,
  age           INTEGER NOT NULL,
  city          TEXT NOT NULL
);

CREATE TABLE projects (
  id            INTEGER PRIMARY KEY,
  project_name  TEXT NOT NULL,
  department_id INTEGER REFERENCES departments (id),
  budget        INTEGER NOT NULL
);

CREATE TABLE employee_projects (
  id          INTEGER PRIMARY KEY,
  employee_id INTEGER REFERENCES employees (id),
  project_id  INTEGER REFERENCES projects (id)
);
`

/** Sample rows matching the documented dataset. */
export const SEED_SQL = `
INSERT INTO departments (id, department_name, location) VALUES
  (1, 'Engineering', 'Delhi'),
  (2, 'Marketing', 'Mumbai'),
  (3, 'HR', 'Bangalore');

INSERT INTO employees (id, name, department_id, salary, age, city) VALUES
  (1, 'Rahul',  1, 45000, 23, 'Delhi'),
  (2, 'Priya',  2, 60000, 24, 'Mumbai'),
  (3, 'Amit',   1, 28000, 22, 'Ranchi'),
  (4, 'Neha',   3, 75000, 26, 'Bangalore'),
  (5, 'Karan',  2, 52000, 25, 'Delhi'),
  (6, 'Sneha',  3, 35000, 23, 'Kolkata'),
  (7, 'Arjun',  1, 90000, 27, 'Pune'),
  (8, 'Pooja',  2, 40000, 22, 'Mumbai');

INSERT INTO projects (id, project_name, department_id, budget) VALUES
  (1, 'AI Assistant',         1, 500000),
  (2, 'Marketing Analytics',  2, 300000),
  (3, 'Recruitment Portal',   3, 200000),
  (4, 'Data Platform',        1, 800000);

INSERT INTO employee_projects (id, employee_id, project_id) VALUES
  (1, 1, 1),
  (2, 2, 2),
  (3, 3, 1),
  (4, 4, 3),
  (5, 5, 2),
  (6, 7, 4),
  (7, 8, 2);
`

/** Tables in dependency order (parents first) — useful for Stage 2. */
export const SEED_TABLE_ORDER = [
  'departments',
  'employees',
  'projects',
  'employee_projects',
] as const
