import type { AiProfile } from "../../../types/ai";
import { IconButton } from "../../ui/Button";
import { Badge, Card } from "../../ui/Surface";
import { TrashIcon } from "../../ui/icons";
import { ProviderLogo } from "./ProviderLogo";

export interface ProfileListProps {
  profiles: AiProfile[];
  activeId: string | null;
  selectedId: string | null;
  busy?: boolean;
  onSelect: (profile: AiProfile) => void;
  onDelete: (profile: AiProfile) => void;
}

function formatVerifiedAt(timestamp: number | null): string {
  if (!timestamp) return "尚未验证";
  return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

/** 已保存档案：当前使用徽标、密钥状态、最近验证时间，点击进入编辑。 */
export function ProfileList({
  profiles,
  activeId,
  selectedId,
  busy = false,
  onSelect,
  onDelete,
}: ProfileListProps) {
  return (
    <div className="space-y-1.5">
      {profiles.map((profile) => {
        const active = activeId === profile.id;
        return (
          <Card
            key={profile.id}
            selected={selectedId === profile.id}
            onClick={() => onSelect(profile)}
            title={`编辑 ${profile.label}`}
            className="px-3 py-2.5"
          >
            <div className="flex items-center gap-2.5">
              <ProviderLogo logoKey={profile.logo_key} label={profile.label} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-os-xs font-medium text-ink">{profile.label}</span>
                  {active && <Badge tone="accent">当前使用</Badge>}
                  {!profile.has_api_key && <Badge tone="warning">未配置密钥</Badge>}
                </div>
                <p className="mt-0.5 truncate font-mono text-os-2xs text-ink-tertiary">
                  {profile.model_id} · {profile.base_url}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <span
                  className={
                    profile.has_api_key
                      ? "block text-os-2xs font-medium text-state-success"
                      : "block text-os-2xs font-medium text-state-warning"
                  }
                >
                  {profile.has_api_key ? "密钥已配置" : "未配置密钥"}
                </span>
                <span className="block text-os-2xs text-ink-tertiary">
                  {formatVerifiedAt(profile.verified_at)}
                </span>
              </div>
              <IconButton
                label="删除档案"
                size="sm"
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(profile);
                }}
              >
                <TrashIcon className="h-3.5 w-3.5" />
              </IconButton>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
