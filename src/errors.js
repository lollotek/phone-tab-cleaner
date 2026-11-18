/** Errore "previsto" del tool: messaggio leggibile + codice di uscita (vedi SPEC §9). */
export class PckError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'PckError';
    this.exitCode = exitCode;
  }
}

export const EXIT = { GENERIC: 1, DEVICE: 2, CHROME: 3, FILE: 4 };
