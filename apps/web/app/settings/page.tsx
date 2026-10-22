import { SettingsForm } from '@/components/settings-form';

export default function SettingsPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Configurações globais</h1>
        <p className="text-sm text-muted-foreground">Provedor de IA, transcrição, threads e aceleração por GPU.</p>
      </div>
      <SettingsForm />
    </div>
  );
}
