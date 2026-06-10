import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { TeamScreen } from "@/screens/team-screen";

export default function HostTeamRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostTeamRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostTeamRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";

  return <TeamScreen serverId={serverId} />;
}
