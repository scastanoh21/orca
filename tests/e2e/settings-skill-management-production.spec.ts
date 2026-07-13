import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const isolatedHome = mkdtempSync(join(tmpdir(), 'orca-e2e-skill-home-'))
const installedRoot = join(isolatedHome, '.agents', 'skills', 'orca-cli')
mkdirSync(installedRoot, { recursive: true })
cpSync(resolve('skills/orca-cli'), installedRoot, { recursive: true })

test.use({
  orcaAppExtraEnv: {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ORCA_E2E_SKILL_HOME_DIR: isolatedHome
  }
})

test.afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true })
})

test('real skill IPC inventories and adopts only inside isolated production roots', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const before = await orcaPage.evaluate(() => window.api.skills.managementInventory())
  const candidate = before.installations.find((entry) => entry.name === 'orca-cli')
  expect(candidate).toMatchObject({
    status: 'known-current',
    managed: false,
    actionsSupported: true
  })

  const after = await orcaPage.evaluate(
    (installationId) => window.api.skills.adopt({ installationId }),
    candidate!.id
  )
  expect(after.installations.find((entry) => entry.id === candidate!.id)).toMatchObject({
    status: 'managed-current',
    managed: true
  })
  expect(readFileSync(join(installedRoot, 'SKILL.md'), 'utf8')).toBe(
    readFileSync(resolve('skills/orca-cli/SKILL.md'), 'utf8')
  )
})
