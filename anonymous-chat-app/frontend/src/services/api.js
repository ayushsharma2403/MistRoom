import axios from 'axios';

const API_BASE_URL = 'http://127.0.0.1:8000/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const createGroup = async (name = '') => {
  const response = await api.post('/groups', { name });
  return response.data;
};

export const getGroups = async () => {
  const response = await api.get('/groups');
  return response.data;
};

export const getGroup = async (groupId) => {
  const response = await api.get(`/groups/${groupId}`);
  return response.data;
};

export const getMessages = async (groupId) => {
  const response = await api.get(`/groups/${groupId}/messages`);
  return response.data;
};

export default api;
