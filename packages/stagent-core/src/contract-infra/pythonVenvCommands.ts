/**
 * Debian/Ubuntu 等环境常缺 python3-venv（ensurepip 不可用），`python3 -m venv .venv` 会直接失败。
 * T4 Cloud Run #63：stage_venv_create exitCode=1，整条流水线在首个 test_run 前中断。
 */
export const VENV_CREATE_RESILIENT_COMMAND =
  'python3 -m venv .venv 2>/dev/null || python3 -m venv --without-pip .venv';

/** venv 由 --without-pip 创建时，先 bootstrap pip 再执行 install。 */
export function withVenvPipBootstrap(venvPython: string, pipInstallTail: string): string {
  const py = venvPython.replace(/'/g, "'\\''");
  return [
    `${py} -m pip --version >/dev/null 2>&1`,
    `|| curl -fsSL https://bootstrap.pypa.io/get-pip.py | ${py}`,
    `; ${py} -m ${pipInstallTail}`,
  ].join(' ');
}
