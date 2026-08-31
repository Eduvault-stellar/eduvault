# Onboarding State Machine

## States

- **pending**: User created but onboarding not started
- **role_selected**: User selected a role
- **provisioned**: Role successfully provisioned (final state)
- **failed**: Provisioning failed
- **disabled**: Account disabled

## Transitions

| From | To | Trigger |
|------|-----|---------|
| pending | role_selected | User selects role |
| role_selected | provisioned | Provisioning success |
| role_selected | failed | Provisioning failure |
| any | disabled | Admin action |
| failed | pending | Retry |
