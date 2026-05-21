import axios from 'axios';

const API_URL = process.env.API_URL || 'http://localhost:3001/api/v1';

export const api = axios.create({
  baseURL: API_URL,
  timeout: 30000,
});

export const setToken = (token: string) => {
  api.defaults.headers.common['Authorization'] = `Bearer ${token}`;
};

export const authApi = {
  telegramLogin: (initData: string) =>
    api.post('/auth/telegram-webapp', { initData }),
};

export const walletApi = {
  getBalance: () => api.get('/wallet/balance'),
  getHistory: () => api.get('/wallet/history'),
};

export const ordersApi = {
  create: (data: any) => api.post('/orders', data),
  list: () => api.get('/orders'),
  cancel: (id: string) => api.delete(`/orders/${id}`),
};

export const rechargeApi = {
  create: (data: any) => api.post('/recharge', data),
  myRequests: () => api.get('/recharge/my'),
};

export const adminApi = {
  getAllRecharges: (status?: string) =>
    api.get('/recharge/admin', { params: { status } }),
  reviewRecharge: (id: string, data: any) =>
    api.patch(`/recharge/admin/${id}/review`, data),
  getUsers: () => api.get('/admin/users'),
};
