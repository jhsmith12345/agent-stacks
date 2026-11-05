//! Heads-up no-limit Hold'em public state machine. Cards enter only after the
//! caller verifies decryption proofs. Each instance represents one hand; the escrow carries awarded stacks into subsequent hands.
use solana_program::program_error::ProgramError;
pub const LEN: usize = 89;
pub const BETTING: u8 = 0;
pub const BOARD: u8 = 1;
pub const SHOWDOWN: u8 = 2;
pub const COMPLETE: u8 = 3;
pub const NONE: u8 = 255;
fn ensure(ok: bool) -> Result<(), ProgramError> {
    if ok {
        Ok(())
    } else {
        Err(ProgramError::InvalidArgument)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Game {
    pub stacks: [u64; 2],
    pub bets: [u64; 2],
    pub contributed: [u64; 2],
    pub current_bet: u64,
    pub min_raise: u64,
    pub big_blind: u64,
    pub actor: u8,
    pub pending: u8,
    pub acted: u8,
    pub street: u8,
    pub stage: u8,
    pub button: u8,
    pub winner: u8,
    pub reason: u8,
    pub board: [u8; 5],
    pub holes: [[u8; 2]; 2],
}
impl Game {
    pub fn new(stacks: [u64; 2], big_blind: u64, button: u8) -> Result<Self, ProgramError> {
        ensure(
            button < 2
                && big_blind >= 2
                && big_blind.is_multiple_of(2)
                && big_blind <= 100_000_000_000
                && stacks.iter().all(|s| *s > 0 && *s <= 2_000_000_000_000),
        )?;
        let mut g = Self {
            stacks,
            bets: [0; 2],
            contributed: [0; 2],
            current_bet: big_blind,
            min_raise: big_blind,
            big_blind,
            actor: button,
            pending: 3,
            acted: 0,
            street: 0,
            stage: BETTING,
            button,
            winner: NONE,
            reason: NONE,
            board: [NONE; 5],
            holes: [[NONE; 2]; 2],
        };
        g.pay(
            button as usize,
            (big_blind / 2).min(g.stacks[button as usize]),
        );
        g.pay(
            1 - button as usize,
            big_blind.min(g.stacks[1 - button as usize]),
        );
        if g.stacks.contains(&0) {
            g.current_bet = g.bets[0].max(g.bets[1]);
        }
        g.progress();
        Ok(g)
    }
    fn pay(&mut self, seat: usize, amount: u64) {
        self.stacks[seat] -= amount;
        self.bets[seat] += amount;
        self.contributed[seat] += amount;
    }
    fn next_street(&mut self) {
        self.street += 1;
        self.stage = BOARD;
        self.actor = NONE;
        self.bets = [0; 2];
        self.current_bet = 0;
        self.min_raise = self.big_blind;
        self.acted = 0;
        self.pending = 0;
        for s in 0..2 {
            if self.stacks[s] > 0 {
                self.pending |= 1 << s;
            }
        }
    }
    fn progress(&mut self) {
        for s in 0..2 {
            if self.stacks[s] == 0 {
                self.pending &= !(1 << s);
            }
        }
        if self.stacks.contains(&0) {
            if let Some(s) = (0..2).find(|&s| self.stacks[s] > 0 && self.bets[s] < self.current_bet)
            {
                self.pending = 1 << s;
                self.actor = s as u8;
                return;
            }
            if self.street < 3 {
                self.next_street();
            } else {
                self.stage = SHOWDOWN;
                self.actor = NONE;
            }
            return;
        }
        if self.pending == 0 {
            if self.street < 3 {
                self.next_street();
            } else {
                self.stage = SHOWDOWN;
                self.actor = NONE;
            }
        } else if self.actor > 1 || self.pending & (1 << self.actor) == 0 {
            self.actor = if self.pending & 1 != 0 { 0 } else { 1 };
        }
    }
    pub fn act(&mut self, seat: u8, mut action: u8, mut amount: u64) -> Result<(), ProgramError> {
        ensure(
            self.stage == BETTING
                && seat < 2
                && self.actor == seat
                && action <= 4
                && (action == 3 || amount == 0),
        )?;
        let s = seat as usize;
        let other = 1 - s;
        let owed = self.current_bet.saturating_sub(self.bets[s]);
        let max = self.bets[s] + self.stacks[s];
        let can_raise =
            self.acted & (1 << seat) == 0 && self.stacks[other] > 0 && max > self.current_bet;
        if action == 0 {
            self.award(Some(other as u8), 0);
            return Ok(());
        }
        if action == 4 {
            ensure(max <= self.current_bet || can_raise)?;
            amount = max;
            action = if max <= self.current_bet { 2 } else { 3 };
        }
        match action {
            1 => ensure(owed == 0)?,
            2 => {
                ensure(owed > 0)?;
                self.pay(s, owed.min(self.stacks[s]));
            }
            3 => {
                ensure(
                    can_raise
                        && amount > self.current_bet
                        && amount <= max
                        && (amount >= self.current_bet + self.min_raise || amount == max),
                )?;
                let increase = amount - self.current_bet;
                self.pay(s, amount - self.bets[s]);
                self.current_bet = amount;
                if increase >= self.min_raise {
                    self.min_raise = increase;
                    self.acted = 0;
                }
                self.pending = 1 << other;
            }
            _ => return Err(ProgramError::InvalidArgument),
        }
        if action != 3 {
            self.pending &= !(1 << seat);
        }
        self.acted |= 1 << seat;
        self.actor = other as u8;
        self.progress();
        Ok(())
    }
    pub fn resume_board(&mut self) -> Result<(), ProgramError> {
        ensure(self.stage == BOARD && (1..=3).contains(&self.street))?;
        let required = if self.street == 1 {
            3
        } else {
            self.street as usize + 2
        };
        ensure(self.board[..required].iter().all(|c| *c < 52))?;
        self.stage = BETTING;
        self.actor = 1 - self.button;
        self.progress();
        Ok(())
    }
    pub fn showdown(&mut self) -> Result<(), ProgramError> {
        ensure(self.stage == SHOWDOWN)?;
        let mut seen = 0u64;
        for c in self.board.iter().chain(self.holes.iter().flatten()) {
            ensure(*c < 52 && seen & (1u64 << c) == 0)?;
            seen |= 1u64 << c;
        }
        let a = evaluate(&[
            self.holes[0][0],
            self.holes[0][1],
            self.board[0],
            self.board[1],
            self.board[2],
            self.board[3],
            self.board[4],
        ])?;
        let b = evaluate(&[
            self.holes[1][0],
            self.holes[1][1],
            self.board[0],
            self.board[1],
            self.board[2],
            self.board[3],
            self.board[4],
        ])?;
        self.award(
            if a == b {
                None
            } else if a > b {
                Some(0)
            } else {
                Some(1)
            },
            1,
        );
        Ok(())
    }
    fn award(&mut self, winner: Option<u8>, reason: u8) {
        let matched = self.contributed[0].min(self.contributed[1]);
        for s in 0..2 {
            self.stacks[s] += self.contributed[s] - matched;
        }
        if let Some(s) = winner {
            self.stacks[s as usize] += 2 * matched;
        } else {
            for s in 0..2 {
                self.stacks[s] += matched;
            }
        }
        self.contributed = [0; 2];
        self.bets = [0; 2];
        self.pending = 0;
        self.acted = 0;
        self.actor = NONE;
        self.stage = COMPLETE;
        self.winner = winner.unwrap_or(2);
        self.reason = reason;
    }
    pub fn encode(&self) -> [u8; LEN] {
        let mut out = [0u8; LEN];
        let values = [
            self.stacks[0],
            self.stacks[1],
            self.bets[0],
            self.bets[1],
            self.contributed[0],
            self.contributed[1],
            self.current_bet,
            self.min_raise,
            self.big_blind,
        ];
        for (i, v) in values.iter().enumerate() {
            out[i * 8..i * 8 + 8].copy_from_slice(&v.to_le_bytes());
        }
        out[72..80].copy_from_slice(&[
            self.actor,
            self.pending,
            self.acted,
            self.street,
            self.stage,
            self.button,
            self.winner,
            self.reason,
        ]);
        out[80..85].copy_from_slice(&self.board);
        out[85..87].copy_from_slice(&self.holes[0]);
        out[87..89].copy_from_slice(&self.holes[1]);
        out
    }
    pub fn decode(data: &[u8]) -> Result<Self, ProgramError> {
        ensure(data.len() == LEN)?;
        let n = |at| u64::from_le_bytes(data[at..at + 8].try_into().unwrap());
        Ok(Self {
            stacks: [n(0), n(8)],
            bets: [n(16), n(24)],
            contributed: [n(32), n(40)],
            current_bet: n(48),
            min_raise: n(56),
            big_blind: n(64),
            actor: data[72],
            pending: data[73],
            acted: data[74],
            street: data[75],
            stage: data[76],
            button: data[77],
            winner: data[78],
            reason: data[79],
            board: data[80..85].try_into().unwrap(),
            holes: [
                data[85..87].try_into().unwrap(),
                data[87..89].try_into().unwrap(),
            ],
        })
    }
}
fn five(cards: &[u8; 5]) -> [u8; 6] {
    let mut count = [0u8; 15];
    for c in cards {
        count[(c / 4 + 2) as usize] += 1;
    }
    let flush = cards.iter().all(|c| c % 4 == cards[0] % 4);
    let straight = (5u8..=14)
        .rev()
        .find(|high| {
            if *high == 5 {
                [14, 2, 3, 4, 5].iter().all(|r| count[*r as usize] > 0)
            } else {
                (*high - 4..=*high).all(|r| count[r as usize] > 0)
            }
        })
        .unwrap_or(0);
    let ranks: Vec<u8> = (2u8..=14)
        .rev()
        .flat_map(|r| std::iter::repeat_n(r, count[r as usize] as usize))
        .collect();
    let groups: Vec<(u8, u8)> = {
        let mut g: Vec<_> = (2u8..=14)
            .filter(|r| count[*r as usize] > 0)
            .map(|r| (count[r as usize], r))
            .collect();
        g.sort_unstable_by(|a, b| b.cmp(a));
        g
    };
    if flush && straight > 0 {
        return [8, straight, 0, 0, 0, 0];
    }
    if groups[0].0 == 4 {
        return [7, groups[0].1, groups[1].1, 0, 0, 0];
    }
    if groups[0].0 == 3 && groups[1].0 == 2 {
        return [6, groups[0].1, groups[1].1, 0, 0, 0];
    }
    if flush {
        return [5, ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]];
    }
    if straight > 0 {
        return [4, straight, 0, 0, 0, 0];
    }
    if groups[0].0 == 3 {
        return [3, groups[0].1, groups[1].1, groups[2].1, 0, 0];
    }
    if groups[0].0 == 2 && groups[1].0 == 2 {
        return [2, groups[0].1, groups[1].1, groups[2].1, 0, 0];
    }
    if groups[0].0 == 2 {
        return [1, groups[0].1, groups[1].1, groups[2].1, groups[3].1, 0];
    }
    [0, ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]]
}
pub fn evaluate(cards: &[u8]) -> Result<[u8; 6], ProgramError> {
    ensure((5..=7).contains(&cards.len()))?;
    let mut seen = 0u64;
    for c in cards {
        ensure(*c < 52 && seen & (1u64 << c) == 0)?;
        seen |= 1u64 << c;
    }
    let mut best = [0u8; 6];
    let n = cards.len();
    for a in 0..n - 4 {
        for b in a + 1..n - 3 {
            for c in b + 1..n - 2 {
                for d in c + 1..n - 1 {
                    for e in d + 1..n {
                        best = best.max(five(&[cards[a], cards[b], cards[c], cards[d], cards[e]]));
                    }
                }
            }
        }
    }
    Ok(best)
}
