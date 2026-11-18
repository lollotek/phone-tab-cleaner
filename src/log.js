import pc from 'picocolors';

/** Logger su stderr: stdout resta libero per i dati (es. `pck tabs --json`). */
export function createLogger(verbose = false) {
  const out = (m) => process.stderr.write(`${m}\n`);
  return {
    verbose,
    info: (m) => out(m),
    ok: (m) => out(`${pc.green('✔')} ${m}`),
    warn: (m) => out(`${pc.yellow('⚠')} ${m}`),
    error: (m) => out(`${pc.red('✖')} ${m}`),
    debug: (m) => verbose && out(pc.dim(m)),
  };
}
