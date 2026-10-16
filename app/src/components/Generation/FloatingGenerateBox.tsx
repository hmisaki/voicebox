import { useMutation, useQuery } from '@tanstack/react-query';
import { useMatchRoute } from '@tanstack/react-router';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Dices,
  HelpCircle,
  Loader2,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormMessage } from '@/components/ui/form';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { apiClient } from '@/lib/api/client';
import { engineSupportsInstruct } from '@/lib/constants/engines';
import { instructHelpFor } from '@/lib/constants/instructHelp';
import { getLanguageOptionsForEngine, type LanguageCode } from '@/lib/constants/languages';
import { useGenerationForm } from '@/lib/hooks/useGenerationForm';
import { useProfile, useProfiles } from '@/lib/hooks/useProfiles';
import { useStory } from '@/lib/hooks/useStories';
import { cn } from '@/lib/utils/cn';
import { formatEngineName } from '@/lib/utils/format';
import { useGenerationStore } from '@/stores/generationStore';
import { useStoryStore } from '@/stores/storyStore';
import { useUIStore } from '@/stores/uiStore';
import { EngineModelSelector } from './EngineModelSelector';
import { ParalinguisticInput } from './ParalinguisticInput';

interface FloatingGenerateBoxProps {
  isPlayerOpen?: boolean;
  showVoiceSelector?: boolean;
}

export function FloatingGenerateBox({
  isPlayerOpen = false,
  showVoiceSelector = false,
}: FloatingGenerateBoxProps) {
  const { t } = useTranslation();
  const selectedProfileId = useUIStore((state) => state.selectedProfileId);
  const setSelectedProfileId = useUIStore((state) => state.setSelectedProfileId);
  const setSelectedEngine = useUIStore((state) => state.setSelectedEngine);
  const { data: selectedProfile } = useProfile(selectedProfileId || '');
  const { data: profiles } = useProfiles();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isInstructExpanded, setIsInstructExpanded] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Last value we auto-filled into the delivery-instructions field, so a
   *  profile switch does not overwrite anything the user typed by hand. */
  const autoInstructRef = useRef<string>('');
  const matchRoute = useMatchRoute();
  const isStoriesRoute = matchRoute({ to: '/stories' });
  const selectedStoryId = useStoryStore((state) => state.selectedStoryId);
  const trackEditorHeight = useStoryStore((state) => state.trackEditorHeight);
  const { data: currentStory } = useStory(selectedStoryId);
  const addPendingStoryAdd = useGenerationStore((s) => s.addPendingStoryAdd);
  const { toast } = useToast();

  const composeMutation = useMutation({
    mutationFn: async () => {
      if (!selectedProfileId) throw new Error('No profile selected');
      return apiClient.composeWithPersonality(selectedProfileId);
    },
    onError: (err: Error) => {
      toast({
        title: t('generation.compose.failedTitle'),
        description: err.message || t('generation.compose.failedDescription'),
        variant: 'destructive',
      });
    },
  });

  // Fetch effect presets for the dropdown
  const { data: effectPresets } = useQuery({
    queryKey: ['effectPresets'],
    queryFn: () => apiClient.listEffectPresets(),
  });

  // Calculate if track editor is visible (on stories route with items)
  const hasTrackEditor = isStoriesRoute && currentStory && currentStory.items.length > 0;

  const { form, handleSubmit, isPending } = useGenerationForm({
    onSuccess: async (generationId) => {
      setIsExpanded(false);
      // Defer the story add until TTS completes -- useGenerationProgress handles it
      if (isStoriesRoute && selectedStoryId && generationId) {
        addPendingStoryAdd(generationId, selectedStoryId);
      }
    },
    getEffectsChain: () => {
      if (!selectedPresetId) return undefined;
      // Profile's own effects chain (no matching preset)
      if (selectedPresetId === '_profile') {
        return selectedProfile?.effects_chain ?? undefined;
      }
      if (!effectPresets) return undefined;
      const preset = effectPresets.find((p) => p.id === selectedPresetId);
      return preset?.effects_chain;
    },
  });

  // Click away handler to collapse the box
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;

      // Don't collapse if clicking inside the container
      if (containerRef.current?.contains(target)) {
        return;
      }

      // Don't collapse if clicking on a Select dropdown (which renders in a portal)
      if (
        target.closest('[role="listbox"]') ||
        target.closest('[data-radix-popper-content-wrapper]')
      ) {
        return;
      }

      setIsExpanded(false);
    }

    if (isExpanded) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isExpanded]);

  // Set first voice as default if none selected
  useEffect(() => {
    if (!selectedProfileId && profiles && profiles.length > 0) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [selectedProfileId, profiles, setSelectedProfileId]);

  // Sync engine selection to global store so ProfileList can filter
  const watchedEngine = form.watch('engine');
  useEffect(() => {
    if (watchedEngine) {
      setSelectedEngine(watchedEngine);
    }
  }, [watchedEngine, setSelectedEngine]);

  // Sync generation form language, engine, and effects with selected profile
  type EngineValue =
    | 'qwen'
    | 'luxtts'
    | 'chatterbox'
    | 'chatterbox_turbo'
    | 'tada'
    | 'kokoro'
    | 'qwen_custom_voice'
    | 'qwen_voice_design'
    | 'omnivoice'
    | 'indextts';
  useEffect(() => {
    if (selectedProfile?.language) {
      form.setValue('language', selectedProfile.language as LanguageCode);
    }
    // Auto-switch engine to match the profile
    const engine = selectedProfile?.default_engine ?? selectedProfile?.preset_engine;
    if (engine) {
      form.setValue('engine', engine as EngineValue);
    } else if (
      selectedProfile &&
      selectedProfile.voice_type !== 'preset' &&
      selectedProfile.voice_type !== 'designed'
    ) {
      // Cloned profile with no default — ensure a compatible (non-preset) engine.
      // Designed profiles are excluded: they always carry a design engine and
      // would be broken by a fallback to qwen.
      const currentEngine = form.getValues('engine');
      const presetEngines = new Set(['kokoro', 'qwen_custom_voice', 'qwen_voice_design']);
      if (currentEngine && presetEngines.has(currentEngine)) {
        form.setValue('engine', 'qwen');
      }
    }
    // Pre-fill effects from profile defaults
    if (
      selectedProfile?.effects_chain &&
      selectedProfile.effects_chain.length > 0 &&
      effectPresets
    ) {
      // Try to match against a known preset
      const profileChainJson = JSON.stringify(selectedProfile.effects_chain);
      const matchingPreset = effectPresets.find(
        (p) => JSON.stringify(p.effects_chain) === profileChainJson,
      );
      if (matchingPreset) {
        setSelectedPresetId(matchingPreset.id);
      } else {
        // No matching preset — use special value to pass profile chain directly
        setSelectedPresetId('_profile');
      }
    } else if (
      selectedProfile &&
      (!selectedProfile.effects_chain || selectedProfile.effects_chain.length === 0)
    ) {
      setSelectedPresetId(null);
    }
    // Persona toggle only applies when the profile has a personality prompt.
    if (selectedProfile && !selectedProfile.personality?.trim()) {
      form.setValue('personality', false);
    }
    // Pre-fill the delivery instructions from the profile default — but never
    // clobber text the user typed. Only fill when the field is empty or still
    // holds the default we filled in for the previous profile. The backend
    // applies the same default when the field is left empty, so this is a
    // convenience, not the source of truth.
    if (selectedProfile && engineSupportsInstruct(form.getValues('engine'))) {
      const profileDefault = selectedProfile.default_instruct?.trim() ?? '';
      const current = (form.getValues('instruct') ?? '').trim();
      if (current === '' || current === autoInstructRef.current.trim()) {
        autoInstructRef.current = profileDefault;
        if (profileDefault) {
          form.setValue('instruct', profileDefault);
          setIsInstructExpanded(true);
        } else if (current !== '') {
          form.setValue('instruct', '');
        }
      }
    }
  }, [selectedProfile, effectPresets, form]);

  // ---- Delivery instructions (instruct) helpers ----------------------------
  const instructEngine = form.watch('engine');
  const instructHelp = instructHelpFor(instructEngine);
  const instructValue = form.watch('instruct') ?? '';
  const profileDefaultInstruct = selectedProfile?.default_instruct?.trim() ?? '';
  // reset 常显（否则用户不知道有这个功能）；只在「档案有默认值且当前值不是它」时可用。
  const canResetInstruct =
    Boolean(profileDefaultInstruct) && instructValue.trim() !== profileDefaultInstruct;

  const insertInstructSnippet = (snippet: string) => {
    const current = form.getValues('instruct') ?? '';
    form.setValue('instruct', current.trim() ? `${current.trimEnd()}\n${snippet}` : snippet, {
      shouldDirty: true,
    });
  };

  const resetInstructToDefault = () => {
    autoInstructRef.current = profileDefaultInstruct;
    form.setValue('instruct', profileDefaultInstruct, { shouldDirty: true });
  };

  // Auto-resize textarea based on content (only when expanded)
  useEffect(() => {
    if (!isExpanded) {
      // Reset textarea height after collapse animation completes
      const timeoutId = setTimeout(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = '32px';
          textarea.style.overflowY = 'hidden';
        }
      }, 200); // Wait for animation to complete
      return () => clearTimeout(timeoutId);
    }

    const textarea = textareaRef.current;
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const scrollHeight = textarea.scrollHeight;
      const minHeight = 100; // Expanded minimum
      const maxHeight = 300; // Max height in pixels
      const targetHeight = Math.max(minHeight, Math.min(scrollHeight, maxHeight));
      textarea.style.height = `${targetHeight}px`;

      // Show scrollbar if content exceeds max height
      if (scrollHeight > maxHeight) {
        textarea.style.overflowY = 'auto';
      } else {
        textarea.style.overflowY = 'hidden';
      }
    };

    // Small delay to let framer animation complete
    const timeoutId = setTimeout(() => {
      adjustHeight();
    }, 200);

    // Adjust on mount and when value changes
    adjustHeight();

    // Watch for input changes
    textarea.addEventListener('input', adjustHeight);

    return () => {
      clearTimeout(timeoutId);
      textarea.removeEventListener('input', adjustHeight);
    };
  }, [isExpanded]);

  async function onSubmit(data: Parameters<typeof handleSubmit>[0]) {
    await handleSubmit(data, selectedProfileId);
  }

  return (
    <motion.div
      ref={containerRef}
      className={cn(
        'fixed',
        isStoriesRoute
          ? // Aligned with StoryContent: sidebar + list width + gap (tab bleeds with -mx-8)
            'left-[calc(5rem+360px+1.5rem)] right-8'
          : 'left-[calc(5rem+2rem)] right-8 lg:right-auto lg:w-[calc((100%-5rem-4rem)/2-1rem)]',
      )}
      style={{
        // On stories route: offset by track editor height when visible
        // On other routes: offset by audio player height when visible
        bottom: hasTrackEditor
          ? `${trackEditorHeight + 24}px`
          : isPlayerOpen
            ? 'calc(7rem + 1.5rem)'
            : '1.5rem',
      }}
    >
      <motion.div
        className="bg-background/30 backdrop-blur-2xl border border-accent/20 rounded-[2rem] shadow-2xl hover:bg-background/40 hover:border-accent/20 transition-all duration-300 p-3"
        transition={{ duration: 0.6, ease: 'easeInOut' }}
      >
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <div className="flex gap-2">
              <motion.div className="flex-1" transition={{ duration: 0.3, ease: 'easeOut' }}>
                <FormField
                  control={form.control}
                  name="text"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <motion.div
                          animate={{
                            height: isExpanded ? 'auto' : '32px',
                          }}
                          transition={{ duration: 0.15, ease: 'easeOut' }}
                          style={{ overflow: 'hidden' }}
                        >
                          {form.watch('engine') === 'chatterbox_turbo' ? (
                            <ParalinguisticInput
                              value={field.value}
                              onChange={field.onChange}
                              placeholder={
                                isStoriesRoute && currentStory
                                  ? t('generation.placeholder.storyWithEffects', {
                                      name: currentStory.name,
                                    })
                                  : selectedProfile
                                    ? t('generation.placeholder.effectsHint')
                                    : t('generation.placeholder.selectVoice')
                              }
                              className="px-3 py-2 resize-none bg-transparent border-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none focus:ring-0 outline-none ring-0 rounded-2xl text-sm w-full"
                              style={{
                                minHeight: isExpanded ? '100px' : '32px',
                                maxHeight: '300px',
                                overflowY: 'auto',
                              }}
                              disabled={!selectedProfileId}
                              onClick={() => setIsExpanded(true)}
                              onFocus={() => setIsExpanded(true)}
                            />
                          ) : (
                            <Textarea
                              {...field}
                              ref={(node: HTMLTextAreaElement | null) => {
                                textareaRef.current = node;
                                if (typeof field.ref === 'function') {
                                  field.ref(node);
                                }
                              }}
                              placeholder={
                                isStoriesRoute && currentStory
                                  ? t('generation.placeholder.story', { name: currentStory.name })
                                  : selectedProfile
                                    ? t('generation.placeholder.profile', {
                                        name: selectedProfile.name,
                                      })
                                    : t('generation.placeholder.selectVoice')
                              }
                              className="resize-none bg-transparent border-none focus-visible:ring-0 focus-visible:ring-offset-0 focus:outline-none focus:ring-0 outline-none ring-0 rounded-2xl text-sm placeholder:text-muted-foreground/60 w-full"
                              style={{
                                minHeight: isExpanded ? '100px' : '32px',
                                maxHeight: '300px',
                              }}
                              disabled={!selectedProfileId}
                              onClick={() => setIsExpanded(true)}
                              onFocus={() => setIsExpanded(true)}
                            />
                          )}
                        </motion.div>
                      </FormControl>
                      <FormMessage className="text-xs" />
                    </FormItem>
                  )}
                />
              </motion.div>

              <div className="flex items-start gap-2 shrink-0">
                {/* Compose — fills the textarea with a fresh in-character line. */}
                <AnimatePresence>
                  {selectedProfile?.personality?.trim() && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.2 }}
                    >
                      <div className="group relative">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={composeMutation.isPending || !selectedProfileId}
                          onClick={async () => {
                            const result = await composeMutation.mutateAsync();
                            form.setValue('text', result.text, { shouldDirty: true });
                            setIsExpanded(true);
                          }}
                          className="h-10 w-10 rounded-full bg-card border border-border hover:bg-background/50 transition-all duration-200"
                          aria-label={t('generation.compose.ariaLabel')}
                        >
                          {composeMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Dices className="h-4 w-4" />
                          )}
                        </Button>
                        <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground border border-border opacity-0 transition-opacity group-hover:opacity-100 z-[9999]">
                          {t('generation.compose.tooltip')}
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Persona — rewrite input through the profile's personality LLM before TTS. */}
                <AnimatePresence>
                  {selectedProfile?.personality?.trim() && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.2 }}
                    >
                      <FormField
                        control={form.control}
                        name="personality"
                        render={({ field }) => {
                          const active = !!field.value;
                          return (
                            <FormItem className="space-y-0">
                              <FormControl>
                                <div className="group relative">
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => field.onChange(!active)}
                                    className={cn(
                                      'h-10 w-10 rounded-full transition-all duration-200',
                                      active
                                        ? 'bg-accent text-accent-foreground border border-accent hover:bg-accent/90'
                                        : 'bg-card border border-border hover:bg-background/50',
                                    )}
                                    aria-label={
                                      active
                                        ? t('generation.persona.ariaLabelActive')
                                        : t('generation.persona.ariaLabelInactive')
                                    }
                                    aria-pressed={active}
                                  >
                                    <Wand2 className="h-4 w-4" />
                                  </Button>
                                  <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground border border-border opacity-0 transition-opacity group-hover:opacity-100 z-[9999]">
                                    {active
                                      ? t('generation.persona.tooltipActive')
                                      : t('generation.persona.tooltipInactive')}
                                  </span>
                                </div>
                              </FormControl>
                            </FormItem>
                          );
                        }}
                      />
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Instruct toggle — only for engines that honor the kwarg (see INSTRUCT_ENGINES) */}
                <AnimatePresence>
                  {isExpanded && engineSupportsInstruct(form.watch('engine')) && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      transition={{ duration: 0.2 }}
                    >
                      <div className="group relative">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => setIsInstructExpanded((prev) => !prev)}
                          className={cn(
                            'h-10 w-10 rounded-full transition-all duration-200',
                            isInstructExpanded
                              ? 'bg-accent text-accent-foreground border border-accent hover:bg-accent/90'
                              : 'bg-card border border-border hover:bg-background/50',
                          )}
                          aria-label={
                            isInstructExpanded
                              ? t('generation.instruct.hide')
                              : t('generation.instruct.show')
                          }
                          aria-pressed={isInstructExpanded}
                        >
                          <SlidersHorizontal className="h-4 w-4" />
                        </Button>
                        <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground border border-border opacity-0 transition-opacity group-hover:opacity-100 z-[9999]">
                          {t('generation.instruct.tooltip')}
                        </span>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="group relative">
                  <Button
                    type="submit"
                    disabled={isPending || !selectedProfileId}
                    className="h-10 w-10 rounded-full bg-accent hover:bg-accent/90 hover:scale-105 text-accent-foreground shadow-lg hover:shadow-accent/50 transition-all duration-200"
                    size="icon"
                    aria-label={
                      isPending
                        ? t('generation.button.generating')
                        : !selectedProfileId
                          ? t('generation.button.selectFirst')
                          : t('generation.button.generate')
                    }
                  >
                    {isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4" />
                    )}
                  </Button>
                  <span className="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-md bg-popover px-3 py-1.5 text-xs text-popover-foreground border border-border opacity-0 transition-opacity group-hover:opacity-100 z-[9999]">
                    {isPending
                      ? t('generation.button.generating')
                      : !selectedProfileId
                        ? t('generation.button.selectFirst')
                        : t('generation.button.generate')}
                  </span>
                </div>
              </div>
            </div>

            {/* Additive instruct textarea — shown below main text when toggle is on and engine supports it */}
            <AnimatePresence>
              {isInstructExpanded && engineSupportsInstruct(form.watch('engine')) && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: 'easeOut' }}
                  className="overflow-hidden"
                >
                  <FormField
                    control={form.control}
                    name="instruct"
                    render={({ field }) => (
                      <FormItem className="mt-2">
                        <div className="relative">
                          <FormControl>
                            <Textarea
                              {...field}
                              placeholder={
                                form.watch('engine') === 'omnivoice'
                                  ? t('generation.instruct.placeholderOmnivoice')
                                  : form.watch('engine') === 'indextts'
                                    ? t('generation.instruct.placeholderIndextts')
                                    : t('generation.instruct.placeholder')
                              }
                              className="resize-none bg-transparent border border-accent/20 focus-visible:ring-1 focus-visible:ring-accent/40 rounded-2xl text-sm placeholder:text-muted-foreground/60 w-full px-3 py-2 pr-16"
                              style={{ minHeight: '60px', maxHeight: '160px' }}
                              maxLength={500}
                            />
                          </FormControl>
                          <div className="absolute right-2 bottom-2 flex items-center gap-1">
                            <button
                              type="button"
                              onClick={resetInstructToDefault}
                              disabled={!canResetInstruct}
                              aria-label={t('generation.instruct.helpReset')}
                              title={
                                !profileDefaultInstruct
                                  ? t('generation.instruct.helpResetNone')
                                  : canResetInstruct
                                    ? t('generation.instruct.helpReset')
                                    : t('generation.instruct.helpResetSame')
                              }
                              className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                            <Popover>
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  aria-label={t('generation.instruct.helpAction')}
                                  title={t('generation.instruct.helpTitle')}
                                  className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-accent/10 hover:text-accent"
                                >
                                  <HelpCircle className="h-4 w-4" />
                                </button>
                              </PopoverTrigger>
                              <PopoverContent
                                key={instructEngine}
                                align="end"
                                side="top"
                                className="max-h-[60vh] w-[26rem] space-y-3 overflow-y-auto text-xs"
                              >
                                <div className="space-y-1">
                                  <p className="text-sm font-medium">
                                    {t('generation.instruct.helpTitle')}
                                    <span className="ml-1 font-mono text-[11px] text-accent">
                                      · {formatEngineName(instructEngine, form.watch('modelSize'))}
                                    </span>
                                  </p>
                                  <p className="text-muted-foreground">
                                    {instructHelp
                                      ? t(`generation.instruct.help.${instructEngine}.summary`)
                                      : t('generation.instruct.helpUnknownEngine')}
                                  </p>
                                </div>

                                <p className="text-[11px] text-muted-foreground/80">
                                  {t('generation.instruct.helpSyntax')}
                                </p>

                                {instructHelp && instructHelp.items.length > 0 && (
                                  <div className="space-y-1.5">
                                    {instructHelp.items.map((item) => (
                                      <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => insertInstructSnippet(item.insert)}
                                        className="flex w-full gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/60"
                                      >
                                        <code className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                                          {item.key}
                                          {item.value ? (
                                            <span className="text-muted-foreground">
                                              ={item.value}
                                            </span>
                                          ) : null}
                                        </code>
                                        <span className="text-muted-foreground">
                                          {t(
                                            `generation.instruct.help.${instructEngine}.items.${item.id}`,
                                          )}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}

                                {instructHelp && instructHelp.examples.length > 0 && (
                                  <div className="space-y-1.5">
                                    <p className="font-medium">
                                      {t('generation.instruct.helpInsert')}
                                    </p>
                                    <div className="flex flex-wrap gap-1.5">
                                      {instructHelp.examples.map((example) => (
                                        <button
                                          key={example}
                                          type="button"
                                          onClick={() => insertInstructSnippet(example)}
                                          className="rounded-full border border-accent/30 px-2 py-0.5 font-mono text-[11px] text-accent transition-colors hover:bg-accent/10"
                                        >
                                          {example}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {instructHelp?.notes && instructHelp.notes.length > 0 && (
                                  <div className="space-y-1 border-t border-border pt-2">
                                    <p className="font-medium text-muted-foreground">
                                      {t('generation.instruct.helpNotes')}
                                    </p>
                                    {instructHelp.notes.map((id) => (
                                      <p key={id} className="text-[11px] text-muted-foreground/80">
                                        •{' '}
                                        {t(
                                          `generation.instruct.help.${instructEngine}.notes.${id}`,
                                        )}
                                      </p>
                                    ))}
                                  </div>
                                )}

                                {instructHelp?.pending && instructHelp.pending.length > 0 && (
                                  <div className="space-y-1 border-t border-border pt-2">
                                    <p className="font-medium text-muted-foreground">
                                      {t('generation.instruct.helpPending')}
                                    </p>
                                    {instructHelp.pending.map((id) => (
                                      <p key={id} className="text-[11px] text-muted-foreground/80">
                                        •{' '}
                                        {t(
                                          `generation.instruct.help.${instructEngine}.pending.${id}`,
                                        )}
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </PopoverContent>
                            </Popover>
                          </div>
                        </div>
                        {profileDefaultInstruct &&
                          instructValue.trim() === profileDefaultInstruct && (
                            <p className="px-1 text-[11px] text-muted-foreground/70">
                              {t('generation.instruct.helpConfigured')}
                            </p>
                          )}
                        <FormMessage className="text-xs" />
                      </FormItem>
                    )}
                  />
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className=" mt-3"
              >
                <div className="flex items-center gap-2">
                  {showVoiceSelector && (
                    <div className="flex-1">
                      <Select
                        value={selectedProfileId || ''}
                        onValueChange={(value) => setSelectedProfileId(value || null)}
                      >
                        <SelectTrigger className="h-8 text-xs bg-card border-border rounded-full hover:bg-background/50 transition-all w-full">
                          <SelectValue placeholder={t('generation.voiceSelector.placeholder')} />
                        </SelectTrigger>
                        <SelectContent side="top">
                          {profiles?.map((profile) => (
                            <SelectItem key={profile.id} value={profile.id} className="text-xs">
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <FormField
                    control={form.control}
                    name="language"
                    render={({ field }) => {
                      const engineLangs = getLanguageOptionsForEngine(
                        form.watch('engine') || 'qwen',
                      );
                      return (
                        <FormItem className="flex-1 space-y-0">
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="h-8 text-xs bg-card border-border rounded-full hover:bg-background/50 transition-all">
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent side="top">
                              {engineLangs.map((lang) => (
                                <SelectItem key={lang.value} value={lang.value} className="text-xs">
                                  {lang.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage className="text-xs" />
                        </FormItem>
                      );
                    }}
                  />

                  <FormItem className="flex-1 space-y-0">
                    <EngineModelSelector form={form} compact />
                  </FormItem>

                  <FormItem className="flex-1 space-y-0">
                    <Select
                      value={selectedPresetId || 'none'}
                      onValueChange={(value) =>
                        setSelectedPresetId(value === 'none' ? null : value)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs bg-card border-border rounded-full hover:bg-background/50 transition-all">
                        <SelectValue placeholder={t('generation.effects.none')} />
                      </SelectTrigger>
                      <SelectContent side="top">
                        <SelectItem value="none" className="text-xs">
                          {t('generation.effects.none')}
                        </SelectItem>
                        {selectedProfile?.effects_chain &&
                          selectedProfile.effects_chain.length > 0 && (
                            <SelectItem value="_profile" className="text-xs">
                              {t('generation.effects.profileDefault')}
                            </SelectItem>
                          )}
                        {effectPresets?.map((preset) => (
                          <SelectItem key={preset.id} value={preset.id} className="text-xs">
                            {preset.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormItem>
                </div>
              </motion.div>
            </AnimatePresence>
          </form>
        </Form>
      </motion.div>
    </motion.div>
  );
}
