import { apiClient } from '@/lib/api/apiClient';

export const savedMaterialService = {
  getSavedMaterials: async () => {
    return apiClient('/api/saved-materials');
  },

  saveMaterial: async (materialId) => {
    return apiClient('/api/saved-materials', {
      method: 'POST',
      body: { materialId },
    });
  },

  unsaveMaterial: async (materialId) => {
    return apiClient(`/api/saved-materials?materialId=${materialId}`, {
      method: 'DELETE',
    });
  },
};
