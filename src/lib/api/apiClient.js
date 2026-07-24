/**
 * A lightweight fetch wrapper for public and authenticated API calls.
 */
export async function apiClient(endpoint, { body, ...customConfig } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.eduvault.v1+json',
    'X-API-Version': '1',
  };

  const config = {
    method: body ? 'POST' : 'GET',
    ...customConfig,
    headers: {
      ...headers,
      ...customConfig.headers,
    },
  };

  // Remove Content-Type if explicitly set to undefined (e.g. for FormData)
  if (config.headers['Content-Type'] === undefined) {
    delete config.headers['Content-Type'];
  }

  if (body) {
    config.body = body instanceof FormData ? body : JSON.stringify(body);
  }

  try {
    const response = await fetch(endpoint, config);
    const serverVersion = response.headers.get('api-version');
    if (serverVersion && serverVersion !== '1') {
      throw Object.assign(new Error(`Unsupported server API version: ${serverVersion}`), {
        code: 'unsupported_api_version',
      });
    }
    
    // Handle successful responses
    if (response.ok) {
      // Check if response is empty
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return await response.json();
      }
      return await response.text();
    }
    
    // Handle specific error statuses
    if (response.status === 401) {
      console.warn('API Unauthorized: Possible session expiry');
    }

    let errorData;
    try {
      errorData = await response.json();
    } catch (e) {
      errorData = { error: 'Unknown server error' };
    }

    const error = new Error(errorData.detail || errorData.error || `HTTP error! status: ${response.status}`);
    error.status = response.status;
    error.code = errorData.code;
    error.correlationId = errorData.correlationId;
    error.data = errorData;
    
    console.error(`API Error [${response.status}] at ${endpoint}:`, error.message);
    throw error;
  } catch (err) {
    // If it's already an error object with status, just rethrow it
    if (err.status || err.code) throw err;
    
    const wrappedError = new Error(err.message || 'Network request failed');
    console.error(`API Network Error at ${endpoint}:`, wrappedError.message);
    throw wrappedError;
  }
}
