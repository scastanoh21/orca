import type { SkillManagementStatus } from '../../../../shared/skill-management'
import { translate } from '@/i18n/i18n'

export function managedSkillStatusCopy(status: SkillManagementStatus): string {
  switch (status) {
    case 'managed-current':
      return translate('auto.components.settings.ManagedOrcaSkills.managedCurrent', 'Managed')
    case 'managed-update-available':
      return translate(
        'auto.components.settings.ManagedOrcaSkills.managedUpdate',
        'Update available'
      )
    case 'known-current':
      return translate(
        'auto.components.settings.ManagedOrcaSkills.availableToManage',
        'Available to manage'
      )
    case 'known-update-available':
      return translate(
        'auto.components.settings.ManagedOrcaSkills.manageAndUpdate',
        'Manage and update'
      )
    case 'newer-known':
      return translate('auto.components.settings.ManagedOrcaSkills.newerKnown', 'Newer release')
    case 'modified':
      return translate('auto.components.settings.ManagedOrcaSkills.modified', 'Modified')
    case 'unknown':
      return translate('auto.components.settings.ManagedOrcaSkills.unknown', 'Unknown copy')
    case 'externally-managed':
      return translate('auto.components.settings.ManagedOrcaSkills.external', 'Externally managed')
    case 'inaccessible':
      return translate('auto.components.settings.ManagedOrcaSkills.inaccessible', 'Inaccessible')
    case 'update-failed':
      return translate('auto.components.settings.ManagedOrcaSkills.failed', 'Update failed')
  }
}
