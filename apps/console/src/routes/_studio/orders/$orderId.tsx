import { createFileRoute } from '@tanstack/react-router';
import { OrderDetailPage } from '../../../pages/OrderDetailPage';

export const Route = createFileRoute('/_studio/orders/$orderId')({
  component: OrderDetailPage,
});
