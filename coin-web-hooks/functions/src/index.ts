import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { USERS } from "./Constants";
import { CoinUtils } from "./Utils";
// import { CommonUtils } from "./CommonUtils";
import { FutureExec } from "./FutureExec";
import * as express from 'express';
import * as cors from 'cors';
import fetch from 'node-fetch';

// const isDebug: boolean = false;

/**
 * admin 초기화 
 */
admin.initializeApp();

/**
 * 선물거래 라우터
 */

export const binanceFutureRouter = functions
    .runWith({ timeoutSeconds: 240 })
    .https.onRequest(async (req, res) => {        

        // 파라미터 로깅
        functions.logger.log(`\u{2705} input params`, req.body);

        const binanceFuture1 = `https://us-central1-coin-web-hooks.cloudfunctions.net/binanceFuture1`
        const binanceFuture2 = `https://us-central1-coin-web-hooks.cloudfunctions.net/binanceFuture2`

        await Promise.all([
            fetch(binanceFuture1, {
                method: 'post',
                body: JSON.stringify(req.body),
                headers: {'Content-Type': 'application/json'}
            }),
            fetch(binanceFuture2, {
                method: 'post',
                body: JSON.stringify(req.body),
                headers: {'Content-Type': 'application/json'}
            })
        ]);

        res.send('ok');
    });

    /**
     * 그룹 1
     */
export const binanceFuture1 = functions
    .runWith({ timeoutSeconds: 240 })
    .https.onRequest(async (req, res) => {
        const groupCd = 1;

        const result = await FutureExec.execute(groupCd, req.body);
        
        res.send(result);
    });

    /**
     * 그룹 2
     */
export const binanceFuture2 = functions
    .runWith({ timeoutSeconds: 240 })
    .https.onRequest(async (req, res) => {
        const groupCd = 2;

        const result = await FutureExec.execute(groupCd, req.body);

        res.send(result);
    });



export const historyCreatedAt = functions.firestore.document('myPositions/{docId}/histories/{historyId}')
    .onCreate(async (history, context) => {
        await history.ref.set({
            createdAt: history.createTime,
            updatedAt: new Date(history.data().updateTime)
        }, { merge: true });
    });

/**
 * 개인별 계좌 발란스 텔레그램 메세지 발송 스케쥴러
 */
 export const sendBalanceFunctionCrontab = functions.pubsub.schedule('5 12 * * *')
    .timeZone('Asia/Sakhalin') // UTC+11(대한민국 UTC+9)('5 11 * * *') 대한민국시간 매일 오전 10시 5분 발송
    .onRun(async (context) => {

        const cid : string = 'atrbb1m';

        for (const user of USERS) {
            if (user.cid !== cid) continue;
            const cu = new CoinUtils(
                user.nickName,
                user.email,
                user.binance.apiKey,
                user.binance.secret,
                'binance',
                { 'defaultType': 'future' } // 기본거래 선물
            );

            const userBalance = await cu.getBalance(user.seed);
            if ('' !== userBalance && '' !== user.telegramId){
                    await cu.sendTelegramMsg(`\u{1F4CA} Daily Report \r\n닉네임 시드 PNL 발란스 수익률\r\n${userBalance.replace(/\-/g, "\\-").replace(/\./g, "\\.")}\u{1F4AA}\u{1F4AF}\u{1F4AA}\u{1F4AF}\u{1F4AA}\u{1F4AF}`, user.telegramId);
            }
        }

        return null;
    });

/**
 * 관리자 통계 스케쥴러
 */
export const scheduledFunctionCrontab = functions.pubsub.schedule('5 11 * * *')
    .timeZone('Asia/Sakhalin') // UTC+11(대한민국 UTC+9)('5 11 * * *') 대한민국시간 매일 오전 9시 5분 발송
    .onRun(async (context) => {

        let usersBalance : string = '';
        const cid : string = 'atrbb1m';

        for (const user of USERS) {
            if (user.cid !== cid) continue;
            const cu = new CoinUtils(
                user.nickName,
                user.email,
                user.binance.apiKey,
                user.binance.secret,
                'binance',
                { 'defaultType': 'future' } // 기본거래 선물
            );

            const userBalance = await cu.getBalance(user.seed);
            usersBalance = usersBalance + userBalance;
        }
        if ('' === usersBalance) {
            functions.logger.log(`유저 발란스 리포트 생성 실패!`);
            return null;
        }
        const cu2 = new CoinUtils('nickName','email','apiKey','secret','binance',{ 'defaultType': 'future' });
        await cu2.sendUserBalance(usersBalance);

        return null;
    });

/**
 * ChooseAutoTradingReportBot 관리자용 명령어봇
    설명	명령어	비고	이슈
    도움말	/help(/h)		
    수익률	/ror		
    메뉴얼모드 확인	/manualMode		
    정상	/normal	0	
    이격추매스킵	/separationPyramidingSkip	1	
    모든추매스킵	/allPyramidingSkip	2	
    모든시그널스킵	/allSignalSkip	3	
    액션 확인	/manualAction		
    추매	/py 50	50%	pyramidingType은 se로 4번까지 가능
    익절	/tp 30	50%	
    로스컷	/sl 0.5	0.50%	마지막 진입가에서 계산
    포지션종료	/positionClose		
 */
export const telegramReportBotRouter = functions.https.onRequest(express()
    .use(cors({ origin: true})) 
    .post('/', async (req, res) => {

        const telegramText = req.body
        && req.body.message
        && req.body.message.chat
        && req.body.message.chat.id
        && req.body.message.from
        && req.body.message.from.first_name

        if (telegramText) {
            const chat_id = req.body.message.chat.id
            const first_name = req.body.message.from.first_name
            const cmdMessage = req.body.message.text.trim()

            let receivedMessage : string = '';

            // 도움말
            if (cmdMessage.indexOf('/') === 0 && (cmdMessage.search(/help/gi) === 1 || cmdMessage.search(/h/gi) === 1)){

                receivedMessage = `\u{1F6A8} ChooseBot Amdin Commander List\r\n
\u{1F539}도움말 \u{1F449} /help (/h)\r\n
\u{1F539}수익률 \u{1F449} /ror\r\n
\u{26A1}\u{26A1}\u{26A1}\u{26A1} Manual Mode \u{26A1}\u{26A1}\u{26A1}\u{26A1}
\u{1F539}메뉴얼모드 확인 \u{1F449} /manualMode
\u{1F539}정상모드 \u{1F449} /normal
\u{1F539}이격추매스킵 \u{1F449} /separationPyramidingSkip
\u{1F539}모든추매스킵 \u{1F449} /allPyramidingSkip
\u{1F539}모든시그널스킵 \u{1F449} /allSignalSkip\r\n
\u{26A1}\u{26A1}\u{26A1}\u{26A1} Manual Action \u{26A1}\u{26A1}\u{26A1}\u{26A1}
\u{1F539}액션 확인 \u{1F449} /manualAction
\u{1F539}추매 \u{1F449} /py 50
\u{1F539}익절 \u{1F449} /tp 30
\u{1F539}스탑로스 \u{1F449} /sl 0.5
\u{1F539}포지션종료 \u{1F449} /positionClose`;

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })

            // 수익률(전체 유저의 수익률 정보 리턴한다.)
            } else if (cmdMessage.indexOf('/') === 0 && cmdMessage.search(/ror/gi) === 1){

                const cid : string = 'atrbb1m';
                

                for (const user of USERS) {
                    if (user.cid !== cid) continue;
                    const cu = new CoinUtils(
                        user.nickName,
                        user.email,
                        user.binance.apiKey,
                        user.binance.secret,
                        'binance',
                        { 'defaultType': 'future' } // 기본거래 선물
                    );

                    const userBalance = await cu.getBalance(user.seed);
                    receivedMessage = receivedMessage + userBalance;                
                }

                if (receivedMessage !== ''){
                    receivedMessage = `\u{1F4CA} Rate Of Return \r\nNickname Seed PNL Balance RoR\r\n${receivedMessage}`;
        
                    functions.logger.log(`chat_id : ${chat_id} , first_name : ${first_name}`, receivedMessage);                      

                    return res.status(200).send({
                        method: 'sendMessage',
                        chat_id,
                        text: receivedMessage
                    })
                }
            // 메뉴얼모드 확인
            }else if (cmdMessage.indexOf('/') === 0 && (cmdMessage.search(/manualMode/gi) === 1)){
                const positionRef = admin.firestore().collection('myPositions').doc('sanghoono@gmail.com');
                const positionData = await positionRef?.get();
                
                const sub = positionData.data()?.manaulMode === 0 ? '정상' : positionData.data()?.manaulMode === 1 ? '이격추매스킵' : positionData.data()?.manaulMode === 2 ? '모든추매스킵' : '모든시그널스킵';
                receivedMessage = `\u{24C2}현재 \u{1F449} ${sub} 모드`;

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })

            // 정상모드 // 이격추매스킵 // 모든추매스킵 // 모든시그널스킵 
            }else if (cmdMessage.indexOf('/') === 0 && ((cmdMessage.search(/normal/gi) === 1) || (cmdMessage.search(/separationPyramidingSkip/gi) === 1) || (cmdMessage.search(/allPyramidingSkip/gi) === 1) || (cmdMessage.search(/allSignalSkip/gi) === 1) )){
                let manaulMode = 0;
                let manaulModeStr = '';
                switch(cmdMessage) { 
                    case 'normal': { manaulMode = 0; manaulModeStr = '정상'; break; } 
                    case 'separationPyramidingSkip':  { manaulMode = 1; manaulModeStr = '이격추매스킵'; break; } 
                    case 'allPyramidingSkip':  { manaulMode = 2; manaulModeStr = '모든추매스킵'; break; } 
                    case 'allSignalSkip':  { manaulMode = 3; manaulModeStr = '모든시그널스킵'; break; } 
                 } 

                 for (const user of USERS) {

                    const positionRef = admin.firestore().collection('myPositions').doc(user.email);
                    await positionRef.update({ manaulMode: manaulMode });
                }
                receivedMessage = `\u{2705} ${manaulModeStr} 설정 완료`;
                functions.logger.log(`\u{2705} chat_id : ${chat_id} , first_name : ${first_name}`, receivedMessage);  

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })

            // 액션 확인
            }else if (cmdMessage.indexOf('/') === 0 && (cmdMessage.search(/manualAction/gi) === 1)){
                receivedMessage = `\u{2705} 개발중 `;

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })
            // 추매
            }else if (cmdMessage.indexOf('/') === 0 && (cmdMessage.search(/py/gi) === 1)){
                const percent = parseInt(cmdMessage.split(' ')[1]);
                if (typeof percent === 'number'){

                    receivedMessage = `\u{2705} 개발중 ${percent}`;
                }else{
                    receivedMessage = `\u{2757} 추매 비중 오류`;
                }

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })
            // 익절
            }else if (cmdMessage.indexOf('/') === 0 && (cmdMessage.search(/tp/gi) === 1)){
                const percent = parseInt(cmdMessage.split(' ')[1]);
                if (percent !== undefined){

                    receivedMessage = `\u{2705} 개발중 `;
                }else{
                    receivedMessage = `\u{2757} 익절 비중 오류`;
                }

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })
            // 스탑로스 
            }else if (cmdMessage.indexOf('/') === 0 && (cmdMessage.search(/sl/gi) === 1)){
                const percent = parseInt(cmdMessage.split(' ')[1]);
                if (percent !== undefined){

                    receivedMessage = `\u{2705} 개발중 `;
                }else{
                    receivedMessage = `\u{2757} 스탑로스 퍼센트 오류`;
                }

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })
            // 포지션종료
            }else if (cmdMessage.indexOf('/') === 0 && (cmdMessage.search(/positionClose/gi) === 1)){

                for (const user of USERS) {
                    const positionRef = admin.firestore().collection('myPositions').doc(user.email);
                    const cu = new CoinUtils(
                        user.nickName,
                        user.email,
                        user.binance.apiKey,
                        user.binance.secret,
                        'binance',
                        { 'defaultType': 'future' } // 기본거래 선물
                    );
                    
                    const results = await cu.closeBinanceFuture("BTC/USDT", positionRef, false);
                    
                    if (results[0].close) functions.logger.log(`\u{2705} chat_id : ${chat_id} , first_name : ${first_name} 메뉴얼 모드로 로스컷 완료`);
                }

                receivedMessage = '\u{2705} 로스컷 완료';

                return res.status(200).send({
                    method: 'sendMessage',
                    chat_id,
                    text: receivedMessage
                })

            // ex)/po 닉네임 (유저 포지션/레버레지/발란스 정보 리턴한다)
            } else if (cmdMessage.indexOf('/') === 0 && cmdMessage.search(/po/gi) === 1 && cmdMessage.split(' ')[1] !== undefined){
    
                functions.logger.log(`chat_id : ${chat_id} , first_name : ${first_name}`);
            }


        }
        return res.status(200).send({status: 'An error occurred'})
    }));



// export const test = functions.https.onRequest(async (req, res) => {
//     // 데이터 가져오기 
//     const posRef = admin.firestore().collection('myPositions');
//     const docRef = admin.firestore().collection('myPositions').doc('korphper@gmail.com');
//     const positionRef = await docRef.get();
//     const myPosition = await positionRef.data();

//     functions.logger.log(myPosition);
//     res.json(myPosition);

//     // 컬렉션을 넣어본다. 
//     const addData = {
//         name: 'jdh',
//         createAt: new Date()
//     };
//     const result = await docRef.collection('histories').add(addData);
//     functions.logger.log(result);
//     res.json(result);
// });


/**
 * 선물거래
 * @parm symbol USDT/BTC 코인명
 * @parm side buy | sell 포지션
 * @parm leverage 10 레버리지 
 * @parm takeProfit 익절
 * @parm stopLoss 손절
 
 export const binanceFuture = functions
    .runWith({ timeoutSeconds: 240 })
    .https.onRequest(async (req, res) => {
        // 입력 파라미터
        const symbol = req.body.symbol;
        let cid = req.body.cid;
        const side: 'buy' | 'sell' = req.body.side;
        const leverage: number = parseFloat(req.body.leverage);
        const takeProfit: any = req.body.takeProfit;
        let stopLoss: any = req.body.stopLoss;
        const safeRatio: number = parseFloat(req.body.safeRatio) || 1; // 비율로 보낼것 
        let addType: 'e' | 'f' | 's' = req.body.addType || 'e'; // e: entry, f:first, s:second 추매타입    
        let addTakeProfitCount: number = CommonUtils.setAddTakeProfitCount(req.body.addTakeProfitCount); // 추매 발동 조건으로 익절수가 현재값을 초과하면 추매를 한다. 
        let addRate: number = CommonUtils.setAddRate(req.body.addRate); // 추매 비율

        // conditions가 있을때만 조건이 일치하는지 체크 
        const conditions: any[] = req.body.conditions;
        const isOnce = (!req.body.isOnce || 'false' === req.body.isOnce) ? false : true;
        
        // 1분봉 캔들이 10%급등락이 있는 비정상적인 상황일때 모든 포진션을 종료하고 메뉴얼모드로 변경한다.
        let isEmergency = req.body.isEmergency;
        if ('false' === isEmergency) isEmergency = false;
        else if ('true' === isEmergency) isEmergency = true;

        // #25 스위칭 서비스 추가         
        const switchZone: any = req.body.switchZone;

        // 파라미터 로깅
        functions.logger.log(`\u{2705} input params`, req.body);

        // 유저 계좌 정보 체크
        let usersBalance : string = '';

        // 텔레그램 전체 메세지
        let telegramMsgsArr = new Array();

        for (const user of USERS) {
            try {
                // cid가 일치하지 않으면 패스한다.
                if (user.cid !== cid) continue;

                const telegramId = user.telegramId;

                // 유저 로깅
                functions.logger.log(`\u{1F449} start user info ${user.nickName} - ${user.email}`);

                let isManualEntry = false;
                let isManualTakeProfit = false;
                const positionRef = admin.firestore().collection('myPositions').doc(user.email);

                // switchZone 정보 업데이트
                if (switchZone) {
                    await positionRef?.set({ switchZone }, { merge: true });
                }

                // switchZone 업데이트 코드 다음에 호출 되어야 정상적인 값을 가져 올 수 있다. 
                let positionData = await positionRef.get();
                const cu = new CoinUtils(
                    user.nickName,
                    user.email,
                    user.binance.apiKey,
                    user.binance.secret,
                    'binance',
                    { 'defaultType': 'future' } // 기본거래 선물
                );
                const myPosition = await cu.myPosition(symbol);
                const mySide = (myPosition.positionAmt > 0) ? "buy" : "sell";

                // 바이낸스의 포지션이 없으면 초기화 #33 #32
                if (0.0 === myPosition.positionAmt && positionData.exists) {
                    await positionRef?.set({ addType: 'e', addCount: 0, positionAmt: 0 }, { merge: true });
                    positionData = await positionRef.get();
                }

                // db에 포지션 정보가 존재하면 유효성 체크 시작 
                if (positionData.exists) {
                    const tmpData = positionData.data();
                    if (tmpData) {
                        isManualEntry = tmpData.isMaualEntry || false;
                        isManualTakeProfit = tmpData.isManualTakeProfit || false;

                        // 조건이 존재하면 체크
                        if (conditions && conditions.length > 0 && conditions.filter(c => c.side === mySide).length > 0) {
                            const findCondition = conditions.filter(c => c.side === mySide).pop();
                            if (findCondition) {
                                if (findCondition.stopLoss) stopLoss = findCondition.stopLoss;
                                if (findCondition.addRate) addRate = CommonUtils.setAddRate(findCondition.addRate);
                                if (findCondition.addType) addType = findCondition.addType || 'e';
                                if (findCondition.cid) cid = findCondition.cid;
                                if (findCondition.addTakeProfitCount) addTakeProfitCount = findCondition.addTakeProfitCount;
                                functions.logger.log(`\u{2611} conditions가 존재`, findCondition);
                            }
                        }

                        // 포지션 변경 일때 side가 다른 경우만 진행이 된다. 
                        // #26 포지션이 존재하지 않으면 포지션을 진행한다.
                        if (addType === 'e' && side === tmpData.side && leverage > 0 && Math.abs(myPosition.positionAmt) > 0) {
                            functions.logger.log(`\u{1F6AB} 이전 포지션(${tmpData.side})와 현재 요청 ${side}가 동일하면 실행하지 않는다. `);
                            continue;
                        }
                        // 추매 시 사이드가 맞지 않으면 스킵
                        if (addType !== 'e' || (addType === 'e' && leverage === 0)) {
                            const mySide = (myPosition.positionAmt > 0) ? 'buy' : (myPosition.positionAmt < 0) ? 'sell' : null;
                            if (mySide && mySide !== side) {
                                functions.logger.log(`\u{1F6AB} 추매, 익절 시에 이전 포지션(${mySide})와 현재 요청 ${side}가 동일하지 않으면 실행하지 않는다. `);
                                continue;
                            }
                        }
                        // isOnce 가 true고 저장된 값도 true면 스킵한다.
                        if (isOnce === true && isOnce === tmpData.isOnce) {
                            functions.logger.log(`\u{1F6AB} isOnce가 ${isOnce} 이고 저장된 값은 ${tmpData.isOnce} 이기 때문에 skip 한다.`);
                            continue;
                        }
                    }
                }

                // 결과 값 저장 
                let result = {
                    close: false,
                    create: false,
                    takeProfit: false,
                    stopLoss: false,
                    telegram: false
                };

                let telegramMsg : string = '';

                // 텔레그램 메세지 테스트
                if (leverage === -999 && !isManualEntry) {
                    if (addType === 'e') {
                        
                        // if ('5295328420' === telegramId){
                            // functions.logger.log('텔레그램 메세지 테스트');
                            const result = await cu.telegramMsgTest(symbol);
                            functions.logger.log('telegramMsgTest result', result);
                            // result.close = result[0]
                            // telegramMsg = result[1]

                            // telegramMsg = result;
                            // const results = await cu.stopLoss(symbol, positionRef, stopLoss.priceString,
                            //     stopLoss.pricePercent, stopLoss.pricePercents, stopLoss.priceNumber, isDebug);
                            // result.stopLoss = results[0];
                            // telegramMsg = telegramMsg + results[1];
                        // }
                        
                    }
                }
                // user Balance Info
                if (leverage === -888 && !isManualEntry) {
                    if (addType === 'e') {
                        
                        const userBalance = await cu.getBalance(user.seed);
                        usersBalance = usersBalance + userBalance;
                        
                    }
                }

                // 청산(로스컷만 실행하려면 leverage에 -1을 넣는다.)(1분봉 ATR 매매봇 #29)
                if (leverage === -1 && !isManualEntry) {
                    if (addType === 'e') {
                        // 로스컷
                        const results = await cu.closeBinanceFuture(symbol, positionRef, isDebug);
                        result.close = results[0];
                        if (result.close) functions.logger.log(`\u{1F44C} 로스컷 완료`);
                        telegramMsg = results[1];
                    }
                }

                // 매수 / 매도 / 추매
                if (leverage > 0 && !isManualEntry) {
                    if (addType === 'e') {
                        // 이전 포지션 청산
                        const results = await cu.closeBinanceFuture(symbol, positionRef, isDebug);
                        if (result.close) functions.logger.log(`\u{1F44C} 이전 포지션 청산 완료`);
                        result.close = results[0];
                    }
                    const results = await cu.createBinanceFuture({
                        symbol, side, leverage, positionRef, safeRatio, cid, addRate, addType, addTakeProfitCount, isOnce
                    }, isDebug);
                    result.create = results[0];
                    telegramMsg = results[1];
                }

                // 익절
                if (takeProfit && Array.isArray(takeProfit.amtPercents) && !isManualTakeProfit) {
                    const results = await cu.takeProfit({ symbol, side, leverage, positionRef, takeProfitObject: takeProfit, cid }, isDebug);
                    result.takeProfit = results[0];
                    telegramMsg = results[1];
                }

                // 스탑로스 (스탑로스값이 넘어오고, 익절이 성공한 경우 스탑로스 다시 )
                if (stopLoss &&
                    (stopLoss.priceString || stopLoss.pricePercent || Array.isArray(stopLoss.pricePercents) || stopLoss.priceNumber)) {

                    // 익절 파라미터 없으면 매수/매도/추매가 성공 했을때
                    // 익절 파라미터 있으면 익절이 성공 했을때 스탑로스건다.
                    if ((!takeProfit && result.create) || (takeProfit && result.takeProfit)) {
                        // functions.logger.log('stopLoss 시작');
                        const results = await cu.stopLoss(symbol, positionRef, stopLoss.priceString,
                            stopLoss.pricePercent, stopLoss.pricePercents, stopLoss.priceNumber, isDebug);
                        result.stopLoss = results[0];
                        telegramMsg = telegramMsg + results[1];
                    }
                }

                // 1분봉 캔들이 10%급등락이 있는 비정상적인 상황일때 모든 포진션을 종료하고 메뉴얼모드로 변경하고 관리자 텔레그램 알람 보낸다.
                if (isEmergency !== undefined){
                    const isManualEntry2 : boolean = isEmergency;   // Type을 강제로 Boolean으로 변경
                    await positionRef.update({ isManualEntry: isManualEntry2 });

                    // 관리자에게 텔레그램 메세지를 보낸다.
                    

                    functions.logger.log(`\u{1F44C} isEmergency`, isEmergency);
                }

                // 매매 내용 텔레그램 메세지 보내기                
                if ('' !== telegramMsg && '' !== telegramId){
                    telegramMsgsArr.push(new Array(telegramId,user.nickName,telegramMsg));
                }            
                
                functions.logger.log(`\u{1F448} ${user.nickName} - ${user.email} 처리 완료`);

            } catch (error) {
                functions.logger.error(error);
            }
        }

        if (telegramMsgsArr.length > 0){
            const cu2 = new CoinUtils('nickName','email','apiKey','secret','binance',{ 'defaultType': 'future' });
            for (var i=0; i<telegramMsgsArr.length; i++){
                await cu2.sendTelegramMsg(telegramMsgsArr[i][2] + `\r\n\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}\u{1F680}`, telegramMsgsArr[i][0]);
            }          
            
            functions.logger.log(telegramMsgsArr);
        }

        // 유저 발란스 뽑기
        if ('' !== usersBalance){
            const cu2 = new CoinUtils('nickName','email','apiKey','secret','binance',{ 'defaultType': 'future' });
            await cu2.sendUserBalance(usersBalance);
        }
        
        res.send('ok');
    });
*/