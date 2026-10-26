import { Suspense } from 'react';
import { CuriosityStudio } from '@/components/curiosity-studio';

export default function CuriosidadesPage() {
  return (
    <Suspense>
      <CuriosityStudio />
    </Suspense>
  );
}
