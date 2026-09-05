function supports(route, inputChannel, outputChannel) {
  return route.input_channels?.includes(inputChannel)
    && route.output_channels?.includes(outputChannel);
}

export function selectFallbackRoute({
  fromRouteId,
  routes = [],
  accessController,
  inputChannel = 'text',
  outputChannel = 'text',
} = {}) {
  if (!accessController?.canUse || !accessController?.envelopeFor) {
    throw new Error('route_access_controller_required');
  }

  const available = routes
    .filter(route => route?.route_id && route.route_id !== fromRouteId)
    .filter(route => route.available === true)
    .filter(route => supports(route, inputChannel, outputChannel))
    .filter(route => accessController.canUse(route.route_id))
    .sort((left, right) => Number(left.priority || 100) - Number(right.priority || 100));

  const automatic = available.find(route => {
    if (route.billing === 'none') return true;
    const envelope = accessController.envelopeFor(route.route_id);
    return envelope?.status === 'approved' && envelope.allow_automatic_fallback === true;
  });
  if (automatic) return { route: automatic, requiresApproval: false, candidates: [] };

  const candidates = available.filter(route => {
    if (route.billing === 'none') return false;
    const envelope = accessController.envelopeFor(route.route_id);
    return envelope?.status === 'approved' && envelope.allow_automatic_fallback !== true;
  });
  return { route: null, requiresApproval: candidates.length > 0, candidates };
}
