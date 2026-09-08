let nextSavepoint = 0;

// Savepoints compose repository writes inside the importer's outer transaction.
// Callbacks must be synchronous because DatabaseSync cannot span asynchronous work.
export function transaction(db, operation) {
  const name = `repository_${++nextSavepoint}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = operation();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}
