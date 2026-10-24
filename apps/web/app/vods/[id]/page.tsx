import { VodReview } from '@/components/vod-review';

export default async function VodPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <VodReview id={id} />;
}
