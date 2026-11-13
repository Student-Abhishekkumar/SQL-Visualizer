/**
 * Executable example queries for the University Database.
 * Every example runs against the seeded sample data.
 */
export interface ExampleQuery {
  id: string
  title: string
  description: string
  sql: string
  /**
   * True when the visualization engine supports this query end to end
   * (single SELECT over the supported pipeline). The Examples menu can
   * use this to point users at visualizable demos.
   */
  visualizable?: boolean
}

/**
 * The seven canonical Stage 2 visualization examples. Each exercises a
 * different pipeline stage combination and is validated against SQLite.
 */
export const VISUALIZATION_EXAMPLES: ExampleQuery[] = [
  {
    id: 'viz-where',
    title: 'Visualize: WHERE filter',
    description: 'See rows filtered one by one as the condition is evaluated.',
    sql: 'SELECT * FROM employees WHERE salary > 50000;',
    visualizable: true,
  },
  {
    id: 'viz-group-count',
    title: 'Visualize: GROUP BY with COUNT',
    description: 'Watch rows being collected into groups, one per department.',
    sql: 'SELECT department_id, COUNT(*) FROM employees GROUP BY department_id;',
    visualizable: true,
  },
  {
    id: 'viz-having',
    title: 'Visualize: GROUP BY + HAVING',
    description: 'Groups formed, aggregates computed, then groups filtered.',
    sql: 'SELECT department_id, AVG(salary) AS average_salary FROM employees GROUP BY department_id HAVING AVG(salary) > 50000;',
    visualizable: true,
  },
  {
    id: 'viz-distinct',
    title: 'Visualize: DISTINCT + ORDER BY',
    description: 'Duplicate cities removed, then the rest sorted.',
    sql: 'SELECT DISTINCT city FROM employees ORDER BY city;',
    visualizable: true,
  },
  {
    id: 'viz-limit',
    title: 'Visualize: ORDER BY + LIMIT',
    description: 'Sorting animated, then the top 3 rows kept.',
    sql: 'SELECT name, salary FROM employees ORDER BY salary DESC LIMIT 3;',
    visualizable: true,
  },
  {
    id: 'viz-full-pipeline',
    title: 'Visualize: WHERE → GROUP BY → ORDER BY',
    description: 'The full pipeline: filter rows, group, aggregate, sort.',
    sql: 'SELECT department_id, COUNT(*) AS total FROM employees WHERE age > 25 GROUP BY department_id ORDER BY total DESC;',
    visualizable: true,
  },
  {
    id: 'viz-complex-where',
    title: 'Visualize: BETWEEN + IN',
    description: 'A compound WHERE with range and list conditions.',
    sql: 'SELECT name, salary FROM employees WHERE salary BETWEEN 40000 AND 70000 AND department_id IN (1, 2) ORDER BY salary DESC;',
    visualizable: true,
  },
]

export const EXAMPLE_QUERIES: ExampleQuery[] = [
  ...VISUALIZATION_EXAMPLES,
  {
    id: 'basic-select',
    title: 'Basic SELECT',
    description: 'Retrieve every row and column from the employees table.',
    sql: 'SELECT * FROM employees;',
  },
  {
    id: 'where',
    title: 'WHERE filter',
    description: 'Filter rows with a salary condition.',
    sql: `SELECT * FROM employees
WHERE salary > 40000;`,
  },
  {
    id: 'order-by',
    title: 'ORDER BY',
    description: 'Sort employees from highest to lowest salary.',
    sql: `SELECT name, salary
FROM employees
ORDER BY salary DESC;`,
  },
  {
    id: 'group-by',
    title: 'GROUP BY',
    description: 'Average salary per department.',
    sql: `SELECT department_id, AVG(salary)
FROM employees
GROUP BY department_id;`,
  },
  {
    id: 'inner-join',
    title: 'INNER JOIN',
    description: 'Combine employees with their department names.',
    sql: `SELECT employees.name, departments.department_name
FROM employees
INNER JOIN departments
  ON employees.department_id = departments.id;`,
  },
  {
    id: 'having',
    title: 'HAVING',
    description: 'Only departments with an average salary above 40000.',
    sql: `SELECT department_id, AVG(salary)
FROM employees
GROUP BY department_id
HAVING AVG(salary) > 40000;`,
  },
  {
    id: 'count',
    title: 'COUNT aggregate',
    description: 'Total number of employees.',
    sql: `SELECT COUNT(*) AS total_employees
FROM employees;`,
  },
  {
    id: 'left-join',
    title: 'LEFT JOIN',
    description: 'All departments, even ones without matching projects.',
    sql: `SELECT departments.department_name, projects.project_name
FROM departments
LEFT JOIN projects
  ON projects.department_id = departments.id;`,
  },
  {
    id: 'subquery',
    title: 'Subquery',
    description: 'Employees earning above the company average.',
    sql: `SELECT name, salary
FROM employees
WHERE salary > (SELECT AVG(salary) FROM employees)
ORDER BY salary DESC;`,
  },
  {
    id: 'multi-table-join',
    title: 'Three-table join',
    description: 'Employees, their projects and department budgets.',
    sql: `SELECT employees.name, projects.project_name, projects.budget
FROM employee_projects
INNER JOIN employees ON employee_projects.employee_id = employees.id
INNER JOIN projects ON employee_projects.project_id = projects.id
ORDER BY projects.budget DESC;`,
  },
  {
    id: 'insert',
    title: 'INSERT a row',
    description: 'Add a new employee, then see them in the explorer.',
    sql: `INSERT INTO employees (id, name, department_id, salary, age, city)
VALUES (9, 'Vikram', 1, 55000, 24, 'Jaipur');`,
  },
  {
    id: 'update',
    title: 'UPDATE a row',
    description: 'Give Amit a raise based on a WHERE condition.',
    sql: `UPDATE employees
SET salary = salary + 5000
WHERE name = 'Amit';`,
  },
  {
    id: 'delete',
    title: 'DELETE a row',
    description: 'Remove an employee by id. Reset the database to undo.',
    sql: `DELETE FROM employees
WHERE id = 6;`,
  },
  {
    id: 'ddl',
    title: 'CREATE TABLE + INSERT',
    description: 'Create a small table, insert, and query it in one go.',
    sql: `CREATE TABLE clubs (
  id INTEGER PRIMARY KEY,
  club_name TEXT NOT NULL
);

INSERT INTO clubs (id, club_name) VALUES (1, 'Chess Club');

SELECT * FROM clubs;`,
  },
]

/** Query shown in the editor on first visit. */
export const DEFAULT_QUERY = EXAMPLE_QUERIES[1]?.sql ?? 'SELECT * FROM employees;'
